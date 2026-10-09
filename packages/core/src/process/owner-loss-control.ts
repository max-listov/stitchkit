import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { NativeCommandError } from './contract';

const MAX_GUARD_MESSAGE_BYTES = 4096;

const OwnerLossGuardMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('started'), pid: z.number().int().positive() }),
  z.strictObject({
    kind: z.literal('unavailable'),
    message: z.string().min(1).max(1024),
    code: z.string().min(1).max(64).optional(),
  }),
]);

interface GuardedChild {
  readonly pid?: number;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

interface GuardRegistration {
  readonly control: Duplex;
  readonly started: Promise<number>;
}

const guards = new WeakMap<object, GuardRegistration>();

/** Tear down a newly created guard group if its private control channel is unavailable. */
export function abortOwnerLossLaunch(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function unavailable(message: string, cause?: unknown): NativeCommandError {
  return new NativeCommandError('COMMAND_UNAVAILABLE', 'Command could not start', {
    cause: cause ?? new Error(message),
  });
}

/** Bind one private inherited control socket to the guard process that owns it. */
export function attachOwnerLossControl(child: GuardedChild, control: Duplex): void {
  const settled = Promise.withResolvers<number>();
  void settled.promise.catch(() => undefined);
  let complete = false;
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  const ignoreSettledError = () => undefined;

  const finish = (outcome: { pid: number } | { error: NativeCommandError }) => {
    if (complete) return;
    complete = true;
    control.off('data', onData);
    control.off('end', onMissing);
    control.off('close', onMissing);
    control.off('error', onError);
    control.on('error', ignoreSettledError);
    control.once('close', () => control.off('error', ignoreSettledError));
    if ('pid' in outcome) settled.resolve(outcome.pid);
    else settled.reject(outcome.error);
  };
  const onMissing = () =>
    finish({ error: unavailable('Owner-loss guard exited before the command started') });
  const onError = (cause: Error) =>
    finish({ error: unavailable('Owner-loss guard control failed', cause) });
  const onData = (chunk: Uint8Array) => {
    if (complete) return;
    bytes += chunk.byteLength;
    if (bytes > MAX_GUARD_MESSAGE_BYTES) {
      finish({ error: unavailable('Owner-loss guard response exceeded its finite bound') });
      return;
    }
    text += decoder.decode(chunk, { stream: true });
    const newline = text.indexOf('\n');
    if (newline < 0) return;
    try {
      const message = OwnerLossGuardMessageSchema.parse(JSON.parse(text.slice(0, newline)));
      if (message.kind === 'started') finish({ pid: message.pid });
      else {
        const cause = new Error(message.message);
        if (message.code !== undefined)
          Object.defineProperty(cause, 'code', { value: message.code });
        finish({ error: unavailable(message.message, cause) });
      }
    } catch (cause) {
      finish({ error: unavailable('Owner-loss guard returned an invalid response', cause) });
    }
  };

  control.on('data', onData);
  control.once('end', onMissing);
  control.once('close', onMissing);
  control.once('error', onError);
  child.on('exit', onMissing);
  guards.set(child, { control, started: settled.promise });
}

/** Preserve the guard registration when an inherited-stdio child gets its transport wrapper. */
export function transferOwnerLossControl(source: object, target: object): void {
  const registration = guards.get(source);
  if (registration !== undefined) guards.set(target, registration);
}

/** Ordinary children are already started; guarded children first prove that their target exists. */
export async function awaitCommandStart(child: GuardedChild): Promise<number | undefined> {
  const registration = guards.get(child);
  if (registration !== undefined) await registration.started;
  return child.pid;
}
