import { z } from 'zod';
import { MAX_TIMER_MS } from '../internal/timers';

const NativeCommandSettlementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exit'),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  z.object({ kind: z.literal('error'), cause: z.unknown() }),
]);
/**
 * How a command's main process ended: `exit` with code and signal, or `error` with the cause;
 * `onLeaderSettled` receives it before inherited pipes finish draining.
 */
export type NativeCommandSettlement = z.infer<typeof NativeCommandSettlementSchema>;

/**
 * Default bound on waiting for a command's handles to close after it was signalled.
 */
export const COMMAND_CLEANUP_TIMEOUT_MS = 2000;

/** The longest grace a stop gives before KILL: one hour, well inside the native timer range. */
export const MAX_COMMAND_STOP_GRACE_MS = 3_600_000;

const NativeCommandStopPolicySchema = z.strictObject({
  target: z.enum(['group', 'leader']),
  signal: z
    .enum(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'])
    .default('SIGTERM'),
  graceMs: z.number().int().nonnegative().max(MAX_COMMAND_STOP_GRACE_MS),
  killOn: z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional(),
});
/**
 * How a cancelled command is stopped: `signal` goes to the whole group (`target: 'group'`) or
 * only to the leader (`'leader'`), the group gets KILL once the grace ends (for `'leader'`, as
 * soon as the leader has exited), and an abort of `killOn` stops at once with KILL.
 */
export type NativeCommandStopPolicy = z.input<typeof NativeCommandStopPolicySchema>;
export type ParsedNativeCommandStopPolicy = z.output<typeof NativeCommandStopPolicySchema>;

/** Options a release removed, each with what replaced it; a refusal names the replacement. */
const REMOVED_NATIVE_COMMAND_OPTIONS: Readonly<Record<string, string>> = {
  killGraceMs: "stop: { target: 'group', graceMs } (removed in 0.105.0)",
};

function unknownOptionMessage(keys: readonly PropertyKey[]): string {
  return keys
    .map((key) => {
      const name = String(key);
      const replacement = Object.hasOwn(REMOVED_NATIVE_COMMAND_OPTIONS, name)
        ? REMOVED_NATIVE_COMMAND_OPTIONS[name]
        : undefined;
      return replacement === undefined
        ? `Unknown runNativeCommand option ${name}`
        : `Unknown runNativeCommand option ${name}; use ${replacement}`;
    })
    .join('; ');
}

export const NativeCommandOptionsSchema = z
  .strictObject(
    {
      executable: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      envPolicy: z.enum(['declared-only', 'ambient']).default('declared-only'),
      signal: z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional(),
      timeoutMs: z.number().int().positive().max(MAX_TIMER_MS).optional(),
      maxOutputBytes: z.number().int().positive().optional(),
      capture: z.boolean().default(false),
      stdin: z.custom<Uint8Array>((v) => v instanceof Uint8Array).optional(),
      maxStdinBytes: z
        .number()
        .int()
        .positive()
        .default(1024 * 1024),
      onOutput: z
        .custom<
          (
            bytes: Uint8Array,
            channel: 'stdout' | 'stderr',
            signal: AbortSignal,
          ) => void | Promise<void>
        >((v) => typeof v === 'function')
        .optional(),
      // Observed leader exit precedes inherited-pipe drain. Failure also settles once.
      onLeaderSettled: z
        .custom<(event: NativeCommandSettlement, signal: AbortSignal) => void | Promise<void>>(
          (v) => typeof v === 'function',
        )
        .optional(),
      stop: NativeCommandStopPolicySchema.default({
        target: 'group',
        signal: 'SIGTERM',
        graceMs: 100,
      }),
      // Safe default (I9): what the leader left in its group is killed once it has exited. A
      // daemon that leaves the group (setsid) is not a member and is never touched.
      descendants: z
        .enum(['terminate-after-leader', 'leave'])
        .default('terminate-after-leader'),
      cleanupTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(30_000)
        .default(COMMAND_CLEANUP_TIMEOUT_MS),
    },
    {
      // A spread can carry a key the type never sees; it is refused by name, never dropped.
      error: (issue) =>
        issue.code === 'unrecognized_keys' ? unknownOptionMessage(issue.keys) : undefined,
    },
  )
  .check((ctx) => {
    const input = ctx.value;
    if (!input.signal && input.timeoutMs === undefined)
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Declare a caller signal or a finite timeout',
      });
    if (input.capture && input.maxOutputBytes === undefined)
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Capture requires a finite combined output budget',
      });
    if (input.stdin && input.stdin.byteLength > input.maxStdinBytes)
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'stdin exceeds maxStdinBytes',
      });
  });
/**
 * Input to `runNativeCommand`: the executable and args, plus a caller signal or finite
 * timeout; capturing output also requires `maxOutputBytes`.
 */
export type NativeCommandOptions = z.input<typeof NativeCommandOptionsSchema>;
export type ParsedNativeCommandOptions = z.output<typeof NativeCommandOptionsSchema>;
const NativeCommandResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  /**
   * `true` when processes the leader left in its group were still there after it exited and
   * were stopped by `descendants: 'terminate-after-leader'`; always `false` under `'leave'`.
   */
  descendantsStopped: z.boolean(),
  stdout: z.instanceof(Uint8Array),
  stderr: z.instanceof(Uint8Array),
});
/**
 * Exit code, signal, whether descendants were stopped after the leader exited, and captured
 * stdout and stderr bytes of a finished command; the buffers stay empty unless `capture` was set.
 */
export type NativeCommandResult = z.infer<typeof NativeCommandResultSchema>;

const NativeCommandLimitReasonSchema = z.enum(['deadline', 'output-budget']);

/**
 * Thrown by `runNativeCommand`; `code` is `COMMAND_LIMIT` (see `reason`),
 * `COMMAND_UNAVAILABLE` (could not start) or `COMMAND_CLEANUP` (handles stayed open past
 * `cleanupTimeoutMs`).
 */
export class NativeCommandError extends Error {
  /** Observed owner limit; set only by `COMMAND_LIMIT` errors that carry evidence of which limit tripped. */
  public readonly reason: z.infer<typeof NativeCommandLimitReasonSchema> | undefined;

  constructor(
    code: 'COMMAND_LIMIT',
    message: string,
    options?: ErrorOptions & { reason?: z.infer<typeof NativeCommandLimitReasonSchema> },
  );
  constructor(
    code: 'COMMAND_LIMIT' | 'COMMAND_UNAVAILABLE' | 'COMMAND_CLEANUP',
    message: string,
    options?: ErrorOptions & { reason?: never },
  );
  constructor(
    public readonly code: 'COMMAND_LIMIT' | 'COMMAND_UNAVAILABLE' | 'COMMAND_CLEANUP',
    message: string,
    options?: ErrorOptions & { reason?: z.infer<typeof NativeCommandLimitReasonSchema> },
  ) {
    super(message, options);
    // The overloads refuse a reason on any other code at compile time; untyped callers hit this.
    if (options?.reason !== undefined && code !== 'COMMAND_LIMIT')
      throw new TypeError('Only COMMAND_LIMIT accepts a limit reason');
    this.reason =
      options?.reason === undefined
        ? undefined
        : NativeCommandLimitReasonSchema.parse(options.reason);
    this.name = 'NativeCommandError';
  }
}
