import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import type { ProcessBuilder } from './ProcessBuilder';

const DOCKER_KILL_COMMAND =
    "pkill -f '[p]hpunit' || true; pkill -f '[p]est' || true; pkill -f '[p]aratest' || true";
const DOCKER_EXEC_OPTIONS_WITH_VALUE = new Set([
    '--detach-keys',
    '--env',
    '-e',
    '--env-file',
    '--user',
    '-u',
    '--workdir',
    '-w',
]);
const DOCKER_COMPOSE_EXEC_OPTIONS_WITH_VALUE = new Set([
    '--env',
    '-e',
    '--user',
    '-u',
    '--workdir',
    '-w',
    '--index',
]);

export class TestRunnerProcess {
    private child?: ChildProcess;
    private emitter = new EventEmitter();
    private output = '';
    private incompleteLineBuffer = '';
    private abortController: AbortController;
    private abortRequested = false;
    private abortEmitted = false;
    private runtime?: string;
    private args: string[] = [];
    private options: SpawnOptions = {};

    constructor(private builder: ProcessBuilder) {
        this.abortController = new AbortController();
    }

    // biome-ignore lint/suspicious/noExplicitAny: EventEmitter callback signature requires any[]
    on(eventName: string, callback: (...args: any[]) => void) {
        this.emitter.on(eventName, callback);

        return this;
    }

    // biome-ignore lint/suspicious/noExplicitAny: EventEmitter emit signature requires any[]
    emit(eventName: string, ...args: any[]) {
        this.emitter.emit(eventName, ...args);
    }

    run() {
        return new Promise((resolve) => {
            this.execute();
            this.child?.on('error', () => resolve(true));
            this.child?.on('close', () => resolve(true));
        });
    }

    getCloverFile() {
        return this.builder.getXdebug()?.getCloverFile();
    }

    abort() {
        this.abortRequested = true;
        this.abortController.abort();
        this.emitAbort();
        this.runDockerExecKillCommand();

        return this.child?.killed;
    }

    private execute() {
        this.output = '';
        this.incompleteLineBuffer = '';

        this.emitter.emit('start', this.builder);
        const { runtime, args, options } = this.builder.build();
        this.runtime = runtime;
        this.args = args;
        this.options = options;
        this.child = spawn(runtime, args, { ...options, signal: this.abortController.signal });
        this.child.stdout?.on('data', (data) => this.processOutput(data));
        this.child.stderr?.on('data', (data) => this.processOutput(data));
        this.child.stdout?.on('end', () => this.flushCompleteLines(this.incompleteLineBuffer));
        this.child.on('error', (err: Error) => this.onChildError(err));
        this.child.on('close', (code) => this.onChildClose(code));
    }

    private processOutput(data: string) {
        const out = data.toString();
        this.output += out;
        this.incompleteLineBuffer += out;
        const lines = this.flushCompleteLines(this.incompleteLineBuffer, 1);
        this.incompleteLineBuffer = lines.shift()!;
    }

    private flushCompleteLines(buffer: string, limit = 0) {
        const lines = buffer.split(/\r\n|\n/);
        while (lines.length > limit) {
            this.emitter.emit('line', lines.shift()!);
        }

        return lines;
    }

    private onChildError(error: Error) {
        if (this.isAbortError(error)) {
            this.emitAbort();
            return;
        }

        this.emitter.emit('error', error);
    }

    private onChildClose(code: number | null) {
        if (this.abortRequested) {
            this.emitAbort();
        }
        this.emitter.emit('close', code, this.output);
    }

    private isAbortError(error: Error) {
        const code = 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;

        return this.abortRequested && (error.name === 'AbortError' || code === 'ABORT_ERR');
    }

    private emitAbort() {
        if (this.abortEmitted) {
            return;
        }

        this.abortEmitted = true;
        this.emitter.emit('abort');
    }

    private runDockerExecKillCommand() {
        const fallbackCommand = this.dockerFallbackCommand();
        if (!fallbackCommand) {
            return;
        }

        const fallbackProcess = spawn(fallbackCommand.runtime, fallbackCommand.args, {
            cwd: this.options.cwd,
            env: this.options.env,
            stdio: 'ignore',
        });
        fallbackProcess.on('error', () => undefined);
        fallbackProcess.unref();
    }

    private dockerFallbackCommand(): { runtime: string; args: string[] } | undefined {
        if (!this.runtime) {
            return;
        }

        const runtime = basename(this.runtime).toLowerCase();
        if (runtime === 'docker') {
            return this.buildDockerExecFallback(this.runtime, this.args);
        }
        if (runtime === 'docker-compose') {
            return this.buildComposeExecFallback(this.runtime, this.args);
        }

        return undefined;
    }

    private buildDockerExecFallback(runtime: string, args: string[]) {
        const execIndex = args.findIndex((arg) => arg === 'exec');
        if (execIndex === -1) {
            return undefined;
        }

        const usesCompose = args.slice(0, execIndex).includes('compose');
        const optionsWithValue = usesCompose
            ? DOCKER_COMPOSE_EXEC_OPTIONS_WITH_VALUE
            : DOCKER_EXEC_OPTIONS_WITH_VALUE;
        const target = this.findExecTarget(args.slice(execIndex + 1), optionsWithValue);
        if (!target) {
            return undefined;
        }

        return {
            runtime,
            args: [
                ...args.slice(0, execIndex),
                'exec',
                target,
                '/bin/sh',
                '-c',
                DOCKER_KILL_COMMAND,
            ],
        };
    }

    private buildComposeExecFallback(runtime: string, args: string[]) {
        const execIndex = args.findIndex((arg) => arg === 'exec');
        if (execIndex === -1) {
            return undefined;
        }

        const target = this.findExecTarget(
            args.slice(execIndex + 1),
            DOCKER_COMPOSE_EXEC_OPTIONS_WITH_VALUE,
        );
        if (!target) {
            return undefined;
        }

        return {
            runtime,
            args: [
                ...args.slice(0, execIndex),
                'exec',
                target,
                '/bin/sh',
                '-c',
                DOCKER_KILL_COMMAND,
            ],
        };
    }

    private findExecTarget(args: string[], optionsWithValue: Set<string>) {
        for (let index = 0; index < args.length; index++) {
            const arg = args[index];
            if (arg === '--') {
                return args[index + 1];
            }

            if (!arg.startsWith('-')) {
                return arg;
            }

            if (arg.includes('=')) {
                continue;
            }

            if (optionsWithValue.has(arg)) {
                index += 1;
            }
        }

        return undefined;
    }

}
