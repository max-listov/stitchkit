import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('/'), 'Path must be absolute')
  .refine(
    (value) => !/[\0\r\n]/.test(value),
    'Path must not contain NUL or newline characters',
  );

const EnvKeySchema = z
  .string()
  .min(1)
  .refine((value) => !/[=\0\r\n]/.test(value), 'Invalid environment variable name');

/** Isolation profile for a long-lived OS-sandboxed provider process. */
export const ProcessSandboxProfileSchema = z.enum(['workspace-strict', 'workspace-readonly']);
/** Isolation profile name inferred from {@link ProcessSandboxProfileSchema}. */
export type ProcessSandboxProfile = z.infer<typeof ProcessSandboxProfileSchema>;

/** Outbound network policy for a long-lived OS-sandboxed process (`'deny'` by default). */
export const ProcessSandboxNetworkSchema = z.enum(['allow', 'deny']);
/** Outbound network policy inferred from {@link ProcessSandboxNetworkSchema}. */
export type ProcessSandboxNetwork = z.infer<typeof ProcessSandboxNetworkSchema>;

/** OS backend used to enforce a long-lived process sandbox. */
export const ProcessSandboxBackendKindSchema = z.enum(['bwrap', 'seatbelt', 'unsupported']);
/** OS backend kind inferred from {@link ProcessSandboxBackendKindSchema}. */
export type ProcessSandboxBackendKind = z.infer<typeof ProcessSandboxBackendKindSchema>;

/** Explicit host Unix socket bind-mounted into the sandbox (for per-space MCP/IPC without exposing host loopback). */
export const ProcessSandboxUnixSocketSchema = z
  .object({
    hostPath: AbsolutePathSchema,
    mountPath: AbsolutePathSchema.optional(),
  })
  .strict();
/** Explicit Unix socket bind definition inferred from {@link ProcessSandboxUnixSocketSchema}. */
export type ProcessSandboxUnixSocket = z.infer<typeof ProcessSandboxUnixSocketSchema>;

function normalizeAbsolute(path: string): string {
  return posix.normalize(path);
}

/**
 * Resolve symlinks on `path`, or on its deepest existing ancestor when the leaf does not exist
 * on disk yet. Falls back to the normalized path when no ancestor can be resolved.
 */
function resolveRealOrAncestor(path: string): string {
  const normalized = normalizeAbsolute(path);
  let cursor = normalized;
  const tail: string[] = [];
  for (;;) {
    try {
      const resolved = realpathSync(cursor);
      return tail.length === 0 ? resolved : posix.join(resolved, ...tail.reverse());
    } catch {
      const parent = posix.dirname(cursor);
      if (parent === cursor) return normalized;
      tail.push(posix.basename(cursor));
      cursor = parent;
    }
  }
}

function lexicalPathsOverlap(a: string, b: string): boolean {
  const normA = normalizeAbsolute(a);
  const normB = normalizeAbsolute(b);
  if (normA === normB) return true;
  const prefixA = normA.endsWith('/') ? normA : `${normA}/`;
  const prefixB = normB.endsWith('/') ? normB : `${normB}/`;
  return normB.startsWith(prefixA) || normA.startsWith(prefixB);
}

function pathsOverlap(a: string, b: string): boolean {
  if (lexicalPathsOverlap(a, b)) return true;
  return lexicalPathsOverlap(resolveRealOrAncestor(a), resolveRealOrAncestor(b));
}

/** Zod specification for {@link createProcessSandbox}: real-path workspace mounts, explicit allowlists, deny masks and network/env policy. */
export const ProcessSandboxSpecSchema = z
  .object({
    /** `'workspace-strict'` mounts `workspace` read-write; `'workspace-readonly'` mounts `workspace` read-only. */
    profile: ProcessSandboxProfileSchema,
    /** Real absolute host path of the workspace directory preserved inside the sandbox. */
    workspace: AbsolutePathSchema,
    /** Explicit writable directories outside the workspace (for example provider profile/state directories). */
    writableDirs: z.array(AbsolutePathSchema).optional(),
    /** Explicit read-only paths (for example provider binaries and runtime libraries). */
    readOnlyPaths: z.array(AbsolutePathSchema).optional(),
    /** Explicit host paths masked or denied inside the sandbox (for example host control sockets). */
    denyPaths: z.array(AbsolutePathSchema).optional(),
    /** Explicit Unix domain sockets exposed inside the sandbox. */
    unixSockets: z.array(ProcessSandboxUnixSocketSchema).optional(),
    /** Network access policy: `'deny'` (default, fail-closed) or `'allow'`. */
    network: ProcessSandboxNetworkSchema.optional(),
    /** Optional allowlist of environment variable names forwarded to the wrapped process. */
    envAllowlist: z.array(EnvKeySchema).optional(),
    /** Optional isolated `HOME` directory path inside the sandbox, overriding host `HOME`. */
    homeDir: AbsolutePathSchema.optional(),
    /** Explicit path to the Linux `bwrap` binary. Defaults to `'/usr/bin/bwrap'`. */
    bwrapExecutable: AbsolutePathSchema.optional(),
    /** Explicit path to macOS `sandbox-exec`. Defaults to `'/usr/bin/sandbox-exec'`. */
    sandboxExecExecutable: AbsolutePathSchema.optional(),
    /** Optional override for default Linux system read-only paths (`/usr`, `/lib`, `/lib64`, `/etc/ssl`, ...). */
    systemReadOnlyPaths: z.array(AbsolutePathSchema).optional(),
    /** Optional private temporary directory mounted writable on Linux (`bwrap --bind`) and macOS (Seatbelt `allow file-write*`) and exported as `TMPDIR`. */
    privateTmpDir: AbsolutePathSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.profile === 'workspace-readonly') {
      if (spec.writableDirs !== undefined) {
        for (let i = 0; i < spec.writableDirs.length; i += 1) {
          const dir = spec.writableDirs[i];
          if (dir !== undefined && pathsOverlap(spec.workspace, dir)) {
            ctx.addIssue({
              code: 'custom',
              path: ['writableDirs', i],
              message:
                'writableDirs must not overlap workspace when profile is "workspace-readonly"',
            });
          }
        }
      }
      if (
        spec.privateTmpDir !== undefined &&
        pathsOverlap(spec.workspace, spec.privateTmpDir)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['privateTmpDir'],
          message:
            'privateTmpDir must not overlap workspace when profile is "workspace-readonly"',
        });
      }
      if (spec.homeDir !== undefined && pathsOverlap(spec.workspace, spec.homeDir)) {
        ctx.addIssue({
          code: 'custom',
          path: ['homeDir'],
          message: 'homeDir must not overlap workspace when profile is "workspace-readonly"',
        });
      }
    }
  });

/** Validated long-lived process sandbox specification inferred from {@link ProcessSandboxSpecSchema}. */
export type ProcessSandboxSpec = z.infer<typeof ProcessSandboxSpecSchema>;

/** Discriminated availability verdict returned by {@link probeProcessSandbox}. */
export const ProcessSandboxProbeResultSchema = z.discriminatedUnion('available', [
  z
    .object({
      available: z.literal(true),
      backend: z.enum(['bwrap', 'seatbelt']),
      executable: z.string().min(1),
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      backend: ProcessSandboxBackendKindSchema,
      reason: z.string().min(1),
    })
    .strict(),
]);

/** Availability verdict inferred from {@link ProcessSandboxProbeResultSchema}. */
export type ProcessSandboxProbeResult = z.infer<typeof ProcessSandboxProbeResultSchema>;

/** Options for {@link probeProcessSandbox}. */
export interface ProcessSandboxProbeOptions {
  /** Override Linux `bwrap` path. Defaults to `'/usr/bin/bwrap'`. */
  readonly bwrapExecutable?: string | undefined;
  /** Override macOS `sandbox-exec` path. Defaults to `'/usr/bin/sandbox-exec'`. */
  readonly sandboxExecExecutable?: string | undefined;
  /** Override detected platform (primarily for deterministic unit testing). */
  readonly platform?: NodeJS.Platform | undefined;
  /** Optional abort signal cancelling the OS sandbox probe promptly. */
  readonly signal?: AbortSignal | undefined;
}

/** Structural command specification compatible with `agent-executor`'s `wrapCommand` hook. */
export interface ProcessSandboxCommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
}

/** Reusable fail-closed OS process sandbox wrapper for long-lived streaming stdio/IPC processes. */
export interface ProcessSandbox {
  readonly profile: ProcessSandboxProfile;
  readonly backend: ProcessSandboxBackendKind;
  /** Probe OS sandbox availability without silently falling back. */
  probe(options?: {
    readonly signal?: AbortSignal | undefined;
  }): Promise<ProcessSandboxProbeResult>;
  /**
   * Rewrite a command into its OS-sandboxed invocation, preserving streaming stdio and real workspace paths.
   * Throws `SandboxError('SANDBOX_UNAVAILABLE', ...)` if the OS sandbox is unavailable.
   */
  readonly wrapCommand: (
    command: ProcessSandboxCommandSpec,
  ) => Promise<ProcessSandboxCommandSpec>;
}

/** Filter and normalize environment variables according to `envAllowlist` and `homeDir`. */
export function resolveProcessSandboxEnv(
  spec: Pick<ProcessSandboxSpec, 'envAllowlist' | 'homeDir' | 'privateTmpDir'>,
  inputEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const allow = spec.envAllowlist !== undefined ? new Set(spec.envAllowlist) : undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputEnv)) {
    if (allow !== undefined && !allow.has(key)) continue;
    out[key] = value;
  }
  if (spec.homeDir !== undefined) {
    out.HOME = spec.homeDir;
  }
  if (spec.privateTmpDir !== undefined) {
    out.TMPDIR = spec.privateTmpDir;
  }
  return out;
}

/** Validate a {@link ProcessSandboxCommandSpec} before wrapping it. */
export function assertProcessSandboxCommand(command: ProcessSandboxCommandSpec): void {
  if (typeof command.executable !== 'string' || command.executable.trim().length === 0) {
    throw new TypeError('ProcessSandbox.wrapCommand requires a non-empty string executable');
  }
  if (!Array.isArray(command.args) || !command.args.every((arg) => typeof arg === 'string')) {
    throw new TypeError('ProcessSandbox.wrapCommand requires string args');
  }
  if (typeof command.cwd !== 'string' || !command.cwd.startsWith('/')) {
    throw new TypeError('ProcessSandbox.wrapCommand requires an absolute cwd path');
  }
}
