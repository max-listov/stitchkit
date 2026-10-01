import { z } from 'zod';

export const NativeCommandOptionsSchema = z
  .strictObject({
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    envPolicy: z.enum(['declared-only', 'ambient']).default('declared-only'),
    signal: z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
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
    killGraceMs: z.number().int().nonnegative().max(10_000).default(100),
    cleanupTimeoutMs: z.number().int().positive().max(30_000).default(2000),
  })
  .superRefine((input, ctx) => {
    if (!input.signal && input.timeoutMs === undefined)
      ctx.addIssue({ code: 'custom', message: 'Declare a caller signal or a finite timeout' });
    if (input.capture && input.maxOutputBytes === undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Capture requires a finite combined output budget',
      });
    if (input.stdin && input.stdin.byteLength > input.maxStdinBytes)
      ctx.addIssue({ code: 'custom', message: 'stdin exceeds maxStdinBytes' });
  });
export type NativeCommandOptions = z.input<typeof NativeCommandOptionsSchema>;
export type ParsedNativeCommandOptions = z.output<typeof NativeCommandOptionsSchema>;
const NativeCommandResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.instanceof(Uint8Array),
  stderr: z.instanceof(Uint8Array),
});
export type NativeCommandResult = z.infer<typeof NativeCommandResultSchema>;

export class NativeCommandError extends Error {
  constructor(
    public readonly code: 'COMMAND_LIMIT' | 'COMMAND_UNAVAILABLE' | 'COMMAND_CLEANUP',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NativeCommandError';
  }
}
