import { Readable, Writable } from 'node:stream';
import type { NativeCommandSettlement } from './contract';
import type { NativeCommandLaunchedOutput, NativeCommandLaunchedProcess } from './launch';

/** Acquired before subscriptions: failed setup and normal execution own the same handles. */
export function createCommandTransport(child: NativeCommandLaunchedProcess) {
  const leader = Promise.withResolvers<NativeCommandSettlement>();
  const closed = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
  const released = Promise.withResolvers<void>();
  const pendingHandles = new Set(['leader', 'launcher', 'stdout', 'stderr']);
  const destructors = new Map<string, () => unknown>();
  let stdout: NativeCommandLaunchedOutput | undefined;
  let stderr: NativeCommandLaunchedOutput | undefined;
  let stdin: Writable | undefined;
  let isClosed = false;
  const release = (name: string) => {
    pendingHandles.delete(name);
    if (pendingHandles.size === 0) released.resolve();
  };
  const settled = (event: NativeCommandSettlement) => {
    leader.resolve(event);
    release('leader');
  };
  const pipe = (name: string, source: Readable | Writable) => {
    if (isClosed || source.closed) release(name);
    else source.once('close', () => release(name));
  };
  return {
    child,
    leader: leader.promise,
    closed: closed.promise,
    released: released.promise,
    pendingHandles,
    get stdin() {
      return stdin;
    },
    observe(onFailure: (cause: Error) => void) {
      // Close is the structural launcher's handle barrier, even if a later subscription refuses.
      child.on('close', (exitCode, signal) => {
        isClosed = true;
        closed.resolve({ exitCode, signal });
        settled({ kind: 'exit', exitCode, signal });
        pendingHandles.clear();
        released.resolve();
      });
      child.on('error', (cause) => {
        settled({ kind: 'error', cause });
        onFailure(cause);
      });
      child.on('exit', (exitCode, signal) => settled({ kind: 'exit', exitCode, signal }));
      if (child.exitCode !== null || child.signalCode !== null)
        settled({ kind: 'exit', exitCode: child.exitCode, signal: child.signalCode });
    },
    capture() {
      stdout = child.stdout;
      destructors.set('stdout', () => stdout?.destroy());
      stderr = child.stderr;
      destructors.set('stderr', () => stderr?.destroy());
      const input = 'stdin' in child ? child.stdin : undefined;
      if (input instanceof Writable) {
        stdin = input;
        pendingHandles.add('stdin');
        destructors.set('stdin', () => input.destroy());
        pipe('stdin', input);
      }
      if (stdout instanceof Readable) pipe('stdout', stdout);
      if (stderr instanceof Readable) pipe('stderr', stderr);
      if (stdout instanceof Readable && stderr instanceof Readable) release('launcher');
      return { stdout, stderr };
    },
    pipeDestructor(name: 'stdout' | 'stderr', destroy: () => unknown) {
      destructors.set(name, destroy);
    },
    destroy() {
      const failures: unknown[] = [];
      for (const name of ['stdin', 'stdout', 'stderr']) {
        try {
          const destroy = destructors.get(name);
          if (destroy) destroy();
          else if (name === 'stdout') child.stdout.destroy();
          else if (name === 'stderr') child.stderr.destroy();
          else if ('stdin' in child && child.stdin instanceof Writable) child.stdin.destroy();
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Command pipe teardown failed');
    },
  };
}

export type NativeCommandTransport = ReturnType<typeof createCommandTransport>;
