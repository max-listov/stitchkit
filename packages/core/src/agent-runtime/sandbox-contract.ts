import { z } from 'zod';
import type { SandboxCodingBinding } from './sandbox-coding';

export const SandboxNetworkPolicySchema = z.union([
  z.literal('allow-all'),
  z.literal('deny-all'),
  z
    .object({
      allow: z.array(
        z
          .object({
            origin: z.url().refine((value) => {
              const u = new URL(value);
              return (
                ['http:', 'https:'].includes(u.protocol) &&
                !u.username &&
                !u.password &&
                u.pathname === '/' &&
                !u.search &&
                !u.hash
              );
            }, 'Expected an HTTP origin'),
            headers: z
              .record(
                z
                  .string()
                  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
                  .refine(
                    (name) =>
                      ![
                        'host',
                        'connection',
                        'content-length',
                        'transfer-encoding',
                        'proxy-authorization',
                        'proxy-connection',
                        'upgrade',
                        'trailer',
                        'te',
                      ].includes(name.toLowerCase()),
                    'Routing and hop-by-hop headers cannot be brokered',
                  ),
                z.string().refine((value) => !/[\r\n\0]/.test(value), 'Invalid header value'),
              )
              .optional(),
          })
          .strict(),
      ),
    })
    .strict()
    .refine(
      (policy) =>
        new Set(policy.allow.map((entry) => new URL(entry.origin).host)).size ===
        policy.allow.length,
      'Each gateway host must have exactly one origin',
    ),
]);
export type SandboxNetworkPolicy = z.infer<typeof SandboxNetworkPolicySchema>;
export const SandboxStateSchema = z
  .object({
    backend: z.string().min(1),
    sessionId: z.string().min(1),
    templateKey: z.string().min(1),
  })
  .strict();
export type SandboxState = z.infer<typeof SandboxStateSchema>;
export const SandboxCommandSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    environment: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  })
  .strict();
export type SandboxCommand = z.infer<typeof SandboxCommandSchema>;
export interface SandboxRunOptions {
  signal?: AbortSignal;
  stdin?: Uint8Array;
}
export interface SandboxProcess {
  readonly result: Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
  stop(): Promise<void>;
}
/** Byte I/O and spawn are the only per-backend session primitives. */
export interface SandboxDriver {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  spawn(command: SandboxCommand, options?: SandboxRunOptions): Promise<SandboxProcess>;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}
export interface SandboxSession {
  readonly id: string;
  /** HTTP gateway socket, present only when the backend supports a host broker. */
  readonly brokerSocket?: string;
  resolvePath(path: string): string;
  readBinaryFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeBinaryFile(path: string, bytes: Uint8Array): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
  removePath(path: string): Promise<void>;
  spawn(command: SandboxCommand, options?: SandboxRunOptions): Promise<SandboxProcess>;
  run(
    command: SandboxCommand,
    options?: SandboxRunOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}
export interface SandboxHandle {
  /** Optional host workspace integration; unsupported backends omit it explicitly. */
  readonly coding?: SandboxCodingBinding;
  readonly session: SandboxSession;
  captureState(): SandboxState;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
  delete(): Promise<void>;
}
export interface SandboxCreateInput {
  template: string;
  state?: SandboxState;
  network: SandboxNetworkPolicy;
}
export interface SandboxPrewarmInput {
  template: string;
  files?: Readonly<Record<string, Uint8Array>>;
}
export interface SandboxBackend {
  readonly name: string;
  prewarm(input: SandboxPrewarmInput): Promise<{ reused: boolean; templateKey: string }>;
  create(input: SandboxCreateInput): Promise<SandboxHandle>;
}
export class SandboxError extends Error {
  constructor(
    readonly code:
      | 'SANDBOX_UNAVAILABLE'
      | 'SANDBOX_BUSY'
      | 'SANDBOX_STOPPED'
      | 'SANDBOX_STATE_MISMATCH'
      | 'SANDBOX_NETWORK_DENIED'
      | 'SANDBOX_LIMIT'
      | 'SANDBOX_PATH',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SandboxError';
  }
}
