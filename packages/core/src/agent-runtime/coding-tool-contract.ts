import { z } from 'zod';

export const AgentCodingToolLimitsSchema = z
  .object({
    maxPathBytes: z.int().positive(),
    maxReadBytes: z.int().positive(),
    maxWriteBytes: z.int().positive(),
    maxShellArguments: z.int().positive(),
    maxShellArgumentBytes: z.int().positive(),
    maxShellOutputBytes: z.int().positive(),
    maxArtifactBytes: z.int().positive(),
    maxListEntries: z.int().positive(),
    maxSearchResults: z.int().positive(),
    maxSearchFiles: z.int().positive(),
    maxSearchDepth: z.int().nonnegative(),
    shellTimeoutMs: z.int().positive(),
    shellTerminationGraceMs: z.int().positive(),
  })
  .strict();

export const AgentCodingToolAuthorizationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read'), path: z.string().min(1) }).strict(),
  z
    .object({
      operation: z.literal('write'),
      path: z.string().min(1),
      bytes: z.int().nonnegative(),
      overwrite: z.boolean(),
      /** Workspace-relative directories this write would create, outermost first. */
      createsDirectories: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      operation: z.literal('search'),
      query: z.string().min(1),
      mode: z.enum(['path', 'content']),
    })
    .strict(),
  z
    .object({
      operation: z.literal('edit'),
      path: z.string().min(1),
      baseSha256: z.string().length(64),
      resultSha256: z.string().length(64),
      resultBytes: z.int().nonnegative(),
      replacements: z.int().positive(),
      dryRun: z.boolean(),
    })
    .strict(),
  z.object({ operation: z.literal('list'), path: z.string().min(1) }).strict(),
  z
    .object({
      operation: z.literal('glob'),
      pattern: z.string().min(1),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      operation: z.literal('artifact-read'),
      reference: z.string().min(1),
      offset: z.int().nonnegative(),
      maxBytes: z.int().positive(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('shell'),
      executable: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().min(1),
    })
    .strict(),
]);

export type AgentCodingToolLimits = z.infer<typeof AgentCodingToolLimitsSchema>;
export type AgentCodingToolAuthorization = z.infer<typeof AgentCodingToolAuthorizationSchema>;

export interface AgentCodingToolConfig {
  root: string;
  authorize(input: AgentCodingToolAuthorization): boolean | Promise<boolean>;
  executables?: Readonly<Record<string, string>>;
  environment?: Readonly<Record<string, string>>;
  artifacts?: AgentCodingArtifactStore;
  search?: {
    /** Directory basenames omitted from workspace search at every depth. */
    excludeDirectories?: readonly string[];
  };
  limits?: Partial<AgentCodingToolLimits>;
}

export interface AgentCodingArtifactStore {
  write(input: {
    mediaType: string;
    data: Uint8Array;
  }): { reference: string } | Promise<{ reference: string }>;
  read(input: {
    reference: string;
    offset: number;
    maxBytes: number;
  }):
    | { data: Uint8Array; totalBytes?: number }
    | Promise<{ data: Uint8Array; totalBytes?: number }>;
}

export interface AgentCodingToolDefinition {
  name: string;
  description: string;
  identity: {
    serviceName: string;
    action: string;
    method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  };
  input: z.ZodObject;
  output: z.ZodType;
  transports?: readonly ('MCP' | 'AGENT' | 'CLI')[];
  handler(context: {
    params: undefined;
    input: unknown;
    signal?: AbortSignal;
    [key: string]: unknown;
  }): unknown | Promise<unknown>;
}

export const FileReadInputSchema = z
  .object({
    path: z.string().min(1),
    offset: z.int().nonnegative().default(0),
    maxBytes: z.int().positive().optional(),
  })
  .strict();

export const FileReadOutputSchema = z
  .object({
    path: z.string().min(1),
    text: z.string(),
    bytes: z.int().nonnegative(),
    sha256: z.string().length(64),
    truncated: z.boolean(),
    nextOffset: z.int().nonnegative().optional(),
  })
  .strict();

export const FileWriteInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    overwrite: z.boolean().default(false),
  })
  .strict();

export const FileWriteOutputSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.int().nonnegative(),
    /**
     * Directories this write created, outermost first.
     *
     * Creating them silently trades one failure for another: a typo stops being
     * an error and becomes a successful write into a tree nobody meant to make.
     * Naming what appeared is the only signal by which a model catches its own
     * `packags/` — cheap, and it keeps the model's picture of the disk true.
     */
    createdDirectories: z.array(z.string().min(1)),
  })
  .strict();

export function createShellInputSchema(executableNames: readonly string[]) {
  if (executableNames.length === 0) {
    throw new Error('A command tool requires at least one executable alias');
  }
  return z
    .object({
      executable: z.enum(executableNames),
      args: z.array(z.string()).default([]),
      cwd: z.string().min(1).default('.'),
    })
    .strict();
}

export const ShellInputSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).default('.'),
  })
  .strict();

export const ShellOutputSchema = z
  .object({
    executable: z.string().min(1),
    exitCode: z.int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    outcome: z.enum(['exited', 'timeout', 'output-limit', 'cancelled']),
    artifact: z
      .object({
        reference: z.string().min(1),
        bytes: z.int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const DEFAULT_LIMITS: AgentCodingToolLimits = {
  maxPathBytes: 4_096,
  maxReadBytes: 262_144,
  maxWriteBytes: 262_144,
  maxShellArguments: 128,
  maxShellArgumentBytes: 65_536,
  maxShellOutputBytes: 262_144,
  maxArtifactBytes: 4_194_304,
  maxListEntries: 500,
  maxSearchResults: 100,
  maxSearchFiles: 10_000,
  maxSearchDepth: 32,
  shellTimeoutMs: 30_000,
  shellTerminationGraceMs: 250,
};

export function resolveCodingToolLimits(
  input: Partial<AgentCodingToolLimits> | undefined,
): AgentCodingToolLimits {
  return AgentCodingToolLimitsSchema.parse({ ...DEFAULT_LIMITS, ...input });
}
