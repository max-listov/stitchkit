import { z } from 'zod';
import type { AgentRuntimeStore } from './store';

export const AgentSandboxRestrictionSchema = z.enum([
  'network-denied',
  'write-contained',
  'secrets-hidden',
  'process-contained',
]);

export const AgentSandboxGradeSchema = z.discriminatedUnion('grade', [
  z
    .object({ grade: z.literal('full'), restrictions: z.array(AgentSandboxRestrictionSchema) })
    .strict(),
  z
    .object({
      grade: z.literal('partial'),
      restrictions: z.array(AgentSandboxRestrictionSchema),
      gaps: z.array(AgentSandboxRestrictionSchema),
    })
    .strict(),
  z.object({ grade: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
]);

export type AgentSandboxRestriction = z.infer<typeof AgentSandboxRestrictionSchema>;
export type AgentSandboxGrade = z.infer<typeof AgentSandboxGradeSchema>;

/** Structural process surface keeps optional launchers independent of Node ambient types. */
export interface AgentSandboxProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout: AgentSandboxOutputStream;
  readonly stderr: AgentSandboxOutputStream;
  kill(signal: 'SIGKILL'): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
}

export interface AgentSandboxOutputStream {
  readonly destroyed: boolean;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  destroy(): unknown;
}

/**
 * A process sandbox adapter. Expected to be long-lived: its probe result is cached by this
 * object's identity ({@link probeAgentProcessSandbox}).
 */
export interface AgentProcessSandbox {
  /** Optional lifecycle-owned launcher; the coding profile still owns output and deadline handling. */
  spawn?(input: Parameters<AgentProcessSandbox['prepare']>[0]): AgentSandboxProcess;
  /** Grade what this sandbox enforces; a throw or a non-grade is read as `unavailable`. */
  probe(): AgentSandboxGrade | Promise<AgentSandboxGrade>;
  prepare(input: {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: Readonly<Record<string, string>>;
    required?: readonly AgentSandboxRestriction[];
  }):
    | {
        executable: string;
        args: readonly string[];
        environment?: Readonly<Record<string, string>>;
      }
    | Promise<{
        executable: string;
        args: readonly string[];
        environment?: Readonly<Record<string, string>>;
      }>;
}

/**
 * A probe's grade and, when the adapter failed, its own error. The cause never goes into the
 * grade: the grade is recorded durably and shown to the agent, and an adapter's error carries
 * absolute paths and raw tool output.
 */
interface AgentSandboxProbeOutcome {
  readonly grade: AgentSandboxGrade;
  readonly cause?: unknown;
}

const probes = new WeakMap<AgentProcessSandbox, Promise<AgentSandboxProbeOutcome>>();

/** The `reason` of the grade when `probe()` threw or rejected. */
const PROBE_FAILED = 'sandbox probe failed';
/** The `reason` of the grade when `probe()` returned something that is not a grade. */
const PROBE_INVALID = 'sandbox probe returned no valid grade';

async function runProbe(sandbox: AgentProcessSandbox): Promise<AgentSandboxProbeOutcome> {
  let value: unknown;
  try {
    // Awaited inside the async body, so a synchronous throw lands here like a rejection.
    value = await sandbox.probe();
  } catch (cause) {
    return { grade: { grade: 'unavailable', reason: PROBE_FAILED }, cause };
  }
  const parsed = AgentSandboxGradeSchema.safeParse(value);
  if (parsed.success) return { grade: parsed.data };
  return { grade: { grade: 'unavailable', reason: PROBE_INVALID }, cause: parsed.error };
}

/**
 * The cached probe with the adapter's failure, for a caller that delivers the cause to the
 * application itself (the coding tools put it on their refusal). Never warns.
 */
export function probeAgentProcessSandboxOutcome(
  sandbox: AgentProcessSandbox,
  options: { refresh?: boolean } = {},
): Promise<AgentSandboxProbeOutcome> {
  if (options.refresh) probes.delete(sandbox);
  const present = probes.get(sandbox);
  if (present) return present;
  const pending = runProbe(sandbox);
  probes.set(sandbox, pending);
  return pending;
}

/**
 * Probe once per process and cache the grade by the sandbox object; `refresh: true` drops the
 * cached grade, used only after the adapter itself fails. Never rejects: a probe that throws
 * (synchronously or not) or returns no valid grade resolves to `grade: 'unavailable'` with a
 * fixed reason, cached like any other grade. This function returns only the grade, so the
 * cause of a probe it ran is emitted as a process warning; the coding tools instead carry it
 * as the `cause` of their refusal to the mount's `onToolError` hook.
 * The cache is keyed by object identity, so create the sandbox once and keep it: a sandbox
 * made per conversation or per call is probed again every time.
 */
export async function probeAgentProcessSandbox(
  sandbox: AgentProcessSandbox,
  options: { refresh?: boolean } = {},
): Promise<AgentSandboxGrade> {
  const fresh = options.refresh === true || !probes.has(sandbox);
  const outcome = await probeAgentProcessSandboxOutcome(sandbox, options);
  if (fresh && outcome.cause !== undefined) {
    process.emitWarning(new Error('Sandbox probe failed', { cause: outcome.cause }));
  }
  return outcome.grade;
}

export function missingSandboxRestrictions(
  grade: AgentSandboxGrade,
  required: readonly AgentSandboxRestriction[],
): readonly AgentSandboxRestriction[] {
  if (grade.grade === 'unavailable') return required;
  const present = new Set(grade.restrictions);
  return required.filter((restriction) => !present.has(restriction));
}

/** Persist the process-wide probe result when a conversation first uses the sandbox. */
export async function recordAgentSandboxProbe(input: {
  store: AgentRuntimeStore;
  conversationId: string;
  sandbox: AgentProcessSandbox;
  required: readonly AgentSandboxRestriction[];
}): Promise<AgentSandboxGrade> {
  const grade = await probeAgentProcessSandbox(input.sandbox);
  const missing = missingSandboxRestrictions(grade, input.required);
  await input.store.appendEvent({
    conversationId: input.conversationId,
    kind: 'sandbox/probed',
    payload: {
      result: grade,
      required: [...input.required],
      missing: [...missing],
    },
  });
  return grade;
}
