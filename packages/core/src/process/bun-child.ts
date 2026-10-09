import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { abortOwnerLossLaunch, attachOwnerLossControl } from './owner-loss-control';
import { type OwnerLossGuardInvocation, ownerLossGuardCommand } from './owner-loss-protocol';
import { connectOwnerLossSocket } from './owner-loss-socket';

/** What a spawned command exposes to its owner: the subset of a Node child the package uses. */
export interface OwnedChild extends EventEmitter {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
}

/** A child spawned with the caller's stdio: it carries no pipes. */
export interface ObservableChild extends EventEmitter {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

interface BunSpawnInput {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  group: boolean;
  ownerLoss?: OwnerLossGuardInvocation;
}

/**
 * Whether the host is Bun. Bun's `node:child_process` can lose a child's `exit` event under
 * host load inside `bun test`; `Bun.spawn` observes the same exit reliably, so under Bun a
 * command is launched through it and presented with the Node child's events and streams.
 */
export function hostIsBun(): boolean {
  return typeof Bun !== 'undefined';
}

/**
 * A Node readable over a web stream whose `destroy` cancels the read in flight. `Readable.from`
 * would wait for that read first, and a pipe a descendant still holds never finishes it.
 */
function readableOf(source: ReadableStream<Uint8Array>): Readable {
  const reader = source.getReader();
  let reading = false;
  return new Readable({
    read() {
      if (reading) return;
      reading = true;
      reader.read().then(
        ({ done, value }) => {
          reading = false;
          if (done) this.push(null);
          else this.push(value);
        },
        (error: unknown) => {
          reading = false;
          this.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      );
    },
    destroy(error, done) {
      reader.cancel().then(
        () => done(error),
        () => done(error),
      );
    },
  });
}

/**
 * The spawn failures a Node child reports as an `error` event; Node throws every other one
 * (E2BIG, ENOTDIR, an invalid argument) from `spawn` itself, and so does this adapter.
 */
const REPORTED_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

function reportedSpawnFailure(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    REPORTED_SPAWN_CODES.has(cause.code)
  );
}

const waitClosed = (stream: Readable) =>
  stream.closed
    ? Promise.resolve()
    : new Promise<void>((resolve) => stream.once('close', () => resolve()));

interface BunSubprocess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly exited: Promise<unknown>;
  readonly stdio: readonly (number | null)[];
  kill(signal: NodeJS.Signals): void;
}

/**
 * Defined on first use: `stitchkit/process` must load where `node:events` is an empty module,
 * so nothing may extend a Node class while the module evaluates.
 */
function defineBunChildren() {
  class BunProcess extends EventEmitter implements ObservableChild {
    pid: number | undefined;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    #subprocess: BunSubprocess | undefined;

    constructor(protected readonly pipes: readonly Readable[]) {
      super();
    }

    watch(subprocess: BunSubprocess) {
      this.pid = subprocess.pid;
      this.#subprocess = subprocess;
      void subprocess.exited.then(() => {
        this.exitCode = subprocess.exitCode;
        this.signalCode = subprocess.signalCode;
        this.emit('exit', this.exitCode, this.signalCode);
        // As a Node child does: a pipe nobody reads is drained, or it would never close.
        for (const pipe of this.pipes) if (pipe.readableFlowing === null) pipe.resume();
        this.closeAfterPipes();
      });
    }

    /** A launch failure reaches the owner as an `error` event, as a Node child reports it. */
    fail(cause: unknown) {
      for (const pipe of this.pipes) pipe.resume();
      setImmediate(() => {
        this.emit('error', cause);
        this.closeAfterPipes();
      });
    }

    kill(signal: NodeJS.Signals): boolean {
      const subprocess = this.#subprocess;
      if (!subprocess || this.exitCode !== null || this.signalCode !== null) return false;
      try {
        subprocess.kill(signal);
        return true;
      } catch {
        return false;
      }
    }

    private closeAfterPipes() {
      void Promise.all(this.pipes.map(waitClosed)).then(() =>
        this.emit('close', this.exitCode, this.signalCode),
      );
    }
  }
  class BunChild extends BunProcess implements OwnedChild {
    constructor(
      readonly stdin: Writable,
      readonly stdout: Readable,
      readonly stderr: Readable,
    ) {
      super([stdout, stderr]);
    }
  }
  return { BunProcess, BunChild };
}

let bunChildren: ReturnType<typeof defineBunChildren> | undefined;
function children() {
  bunChildren ??= defineBunChildren();
  return bunChildren;
}

/** The child's stdin as a Node writable; destroying it closes the pipe, as on a Node child. */
function sinkWritable(sink: {
  write(chunk: Uint8Array): number | Promise<number>;
  end(): number | Promise<number>;
}) {
  let ended = false;
  const end = () => {
    if (ended) return Promise.resolve(0);
    ended = true;
    return Promise.resolve().then(() => sink.end());
  };
  return new Writable({
    write(chunk: Uint8Array, _encoding, done) {
      Promise.resolve()
        .then(() => sink.write(chunk))
        .then(() => done(), done);
    },
    final(done) {
      end().then(() => done(), done);
    },
    destroy(error, done) {
      end().then(
        () => done(error),
        () => done(error),
      );
    },
  });
}

/** `spawnOwnedCommand` for Bun: a command with piped stdio. */
export function spawnBunChild(input: BunSpawnInput): OwnedChild {
  const { BunChild } = children();
  try {
    const ownerLoss = input.ownerLoss;
    const guarded = ownerLoss !== undefined;
    const command = guarded
      ? ownerLossGuardCommand(ownerLoss, input.executable, input.args)
      : [input.executable, ...input.args];
    const subprocess = guarded
      ? Bun.spawn(command, {
          cwd: input.cwd,
          env: input.env,
          detached: input.group,
          stdio: ['pipe', 'pipe', 'pipe', 'socket-fd'],
        })
      : Bun.spawn(command, {
          cwd: input.cwd,
          env: input.env,
          detached: input.group,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
    const child = new BunChild(
      sinkWritable(subprocess.stdin),
      readableOf(subprocess.stdout),
      readableOf(subprocess.stderr),
    );
    child.watch(subprocess);
    if (guarded) {
      const fd = subprocess.stdio[3];
      if (typeof fd !== 'number') {
        abortOwnerLossLaunch(subprocess.pid);
        throw new Error('Owner-loss guard supplied no control socket');
      }
      attachOwnerLossControl(child, connectOwnerLossSocket(fd));
    }
    return child;
  } catch (cause) {
    if (!reportedSpawnFailure(cause)) throw cause;
    const child = new BunChild(
      new Writable({ write: (_chunk, _encoding, done) => done() }),
      Readable.from([]),
      Readable.from([]),
    );
    child.fail(cause);
    return child;
  }
}

/** `spawnInheritedCommand` for Bun: a command with the caller's stdio. */
export function spawnBunInheritedChild(input: BunSpawnInput): ObservableChild {
  const { BunProcess } = children();
  const child = new BunProcess([]);
  try {
    const ownerLoss = input.ownerLoss;
    const guarded = ownerLoss !== undefined;
    const command = guarded
      ? ownerLossGuardCommand(ownerLoss, input.executable, input.args)
      : [input.executable, ...input.args];
    const subprocess = guarded
      ? Bun.spawn(command, {
          cwd: input.cwd,
          env: input.env,
          detached: input.group,
          stdio: ['inherit', 'inherit', 'inherit', 'socket-fd'],
        })
      : Bun.spawn(command, {
          cwd: input.cwd,
          env: input.env,
          detached: input.group,
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        });
    child.watch(subprocess);
    if (guarded) {
      const fd = subprocess.stdio[3];
      if (typeof fd !== 'number') {
        abortOwnerLossLaunch(subprocess.pid);
        throw new Error('Owner-loss guard supplied no control socket');
      }
      attachOwnerLossControl(child, connectOwnerLossSocket(fd));
    }
  } catch (cause) {
    if (!reportedSpawnFailure(cause)) throw cause;
    child.fail(cause);
  }
  return child;
}

export interface BunGuardTarget {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
  readonly exited: Promise<unknown>;
}

/** Bun-native target observation for the standalone owner-loss guard. */
export function spawnBunGuardTarget(
  executable: string,
  args: readonly string[],
): BunGuardTarget {
  return Bun.spawn([executable, ...args], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
}
