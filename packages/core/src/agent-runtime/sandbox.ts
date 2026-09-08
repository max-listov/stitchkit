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

export interface AgentProcessSandbox {
  probe(): AgentSandboxGrade | Promise<AgentSandboxGrade>;
  prepare(input: {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: Readonly<Record<string, string>>;
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
