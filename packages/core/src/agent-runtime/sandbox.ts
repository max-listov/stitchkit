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

export interface AgentProcessSandbox {
  /** Optional lifecycle-owned launcher; the coding profile still owns output and deadline handling. */
  spawn?(input: Parameters<AgentProcessSandbox['prepare']>[0]): AgentSandboxProcess;
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

const probes = new WeakMap<AgentProcessSandbox, Promise<AgentSandboxGrade>>();

/** Probe once per process; invalidate only after the sandbox adapter itself fails. */
export function probeAgentProcessSandbox(
  sandbox: AgentProcessSandbox,
  options: { refresh?: boolean } = {},
): Promise<AgentSandboxGrade> {
  if (options.refresh) probes.delete(sandbox);
  const present = probes.get(sandbox);
  if (present) return present;
  const pending = Promise.resolve(sandbox.probe()).then((grade) =>
    AgentSandboxGradeSchema.parse(grade),
  );
  probes.set(sandbox, pending);
  return pending;
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
