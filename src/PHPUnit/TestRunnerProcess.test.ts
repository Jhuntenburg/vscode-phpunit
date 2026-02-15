import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { Configuration } from './Configuration';
import { ProcessBuilder } from './ProcessBuilder';
import { TestRunner } from './TestRunner';
import { TestRunnerEvent } from './TestRunnerObserver';
import { TestRunnerProcess } from './TestRunnerProcess';

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, spawn: vi.fn() };
});

type ChildProcessEvent = 'error' | 'close';

const createBuilder = (command = '${php} ${phpargs} ${phpunit} ${phpunitargs}') =>
    new ProcessBuilder(
        new Configuration({
            command,
            php: 'php',
            phpunit: 'vendor/bin/phpunit',
            args: ['-c', 'phpunit.xml'],
        }),
        { cwd: '/tmp/phpunit-project' },
    );

const createMockChildProcess = (): {
    child: ChildProcess;
    emit: (event: ChildProcessEvent, ...args: unknown[]) => void;
} => {
    const listeners = new Map<ChildProcessEvent, Array<(...args: unknown[]) => void>>();
    const child = {
        exitCode: null as number | null,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: ChildProcessEvent, callback: (...args: unknown[]) => void) => {
            const callbacks = listeners.get(event) ?? [];
            callbacks.push(callback);
            listeners.set(event, callbacks);

            return child;
        }),
        kill: vi.fn(() => true),
        unref: vi.fn(),
    } as unknown as ChildProcess;

    const emit = (event: ChildProcessEvent, ...args: unknown[]) => {
        if (event === 'close') {
            const [code] = args;
            (child as unknown as { exitCode: number | null }).exitCode =
                typeof code === 'number' ? code : null;
        }

        for (const callback of listeners.get(event) ?? []) {
            callback(...args);
        }
    };

    return { child, emit };
};

describe('TestRunnerProcess cancellation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not run docker fallback for non-docker commands', async () => {
        const main = createMockChildProcess();
        const spawnMock = spawn as unknown as Mock;
        spawnMock.mockReturnValue(main.child);

        const process = new TestRunnerProcess(createBuilder());
        const runPromise = process.run();

        process.abort();
        expect(spawnMock).toHaveBeenCalledTimes(1);

        main.emit('close', 137);
        await runPromise;
    });

    it('runs docker exec fallback kill command on abort', async () => {
        const main = createMockChildProcess();
        const fallback = createMockChildProcess();
        const spawnMock = spawn as unknown as Mock;
        spawnMock.mockReturnValueOnce(main.child).mockReturnValueOnce(fallback.child);

        const process = new TestRunnerProcess(createBuilder('docker exec -t ripm /bin/sh -c'));
        const runPromise = process.run();

        process.abort();
        expect(spawnMock).toHaveBeenNthCalledWith(
            2,
            'docker',
            [
                'exec',
                'ripm',
                '/bin/sh',
                '-c',
                expect.stringContaining("pkill -f '[p]hpunit'"),
            ],
            expect.objectContaining({ stdio: 'ignore' }),
        );

        main.emit('close', 137);
        await runPromise;
    });

    it('forwards abort event through TestRunner observers', async () => {
        const main = createMockChildProcess();
        (spawn as unknown as Mock).mockReturnValue(main.child);

        const runner = new TestRunner();
        const onAbort = vi.fn();
        runner.on(TestRunnerEvent.abort, onAbort);

        const process = runner.run(createBuilder());
        const runPromise = process.run();
        process.abort();
        main.emit('close', 137);
        await runPromise;

        expect(onAbort).toHaveBeenCalledTimes(1);
    });
});
