import { AgentJsonObjectSchema, AgentMessagePartSchema } from 'stitchkit/agent-runtime';
import type { HeadlessAgentHarness } from 'stitchkit/agent-runtime/harness';
import { z } from 'zod';

export const HeadlessAgentRunnerControlSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('submit'),
      requestId: z.string().min(1),
      conversationId: z.string().min(1),
      idempotencyKey: z.string().min(1),
      context: z.json(),
      parts: z.array(AgentMessagePartSchema),
      metadata: AgentJsonObjectSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interrupt'),
      requestId: z.string().min(1),
      conversationId: z.string().min(1),
      runId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('snapshot'),
      requestId: z.string().min(1),
      conversationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('close'),
      requestId: z.string().min(1),
      gracePeriodMs: z.int().nonnegative().optional(),
      forceTimeoutMs: z.int().nonnegative().optional(),
    })
    .strict(),
]);

export type HeadlessAgentRunnerControl = z.infer<typeof HeadlessAgentRunnerControlSchema>;

export interface HeadlessAgentRunnerConfig<CONTEXT> {
  harness: HeadlessAgentHarness<CONTEXT>;
  input: AsyncIterable<unknown>;
  write(value: unknown): void | Promise<void>;
}

/**
 * Reference structured control loop for an externally supervised executable.
 * Framing, authentication, process placement and restart remain host concerns.
 */
export async function runHeadlessAgentRunner<CONTEXT>(
  config: HeadlessAgentRunnerConfig<CONTEXT>,
): Promise<void> {
  const terminal = new Set<Promise<void>>();
  for await (const raw of config.input) {
    const control = HeadlessAgentRunnerControlSchema.parse(raw);
    if (control.type === 'submit') {
      const ticket = config.harness.submit({
        conversationId: control.conversationId,
        idempotencyKey: control.idempotencyKey,
        context: control.context,
        parts: control.parts,
        ...(control.metadata && { metadata: control.metadata }),
      });
      const admission = await ticket.admission;
      await config.write({ type: 'admitted', requestId: control.requestId, admission });
      const completion = ticket.result
        .then((result) =>
          config.write({ type: 'terminal', requestId: control.requestId, result }),
        )
        .then(() => undefined)
        .finally(() => terminal.delete(completion));
      terminal.add(completion);
      continue;
    }
    if (control.type === 'interrupt') {
      const result = await config.harness.interrupt({
        conversationId: control.conversationId,
        runId: control.runId,
      });
      await config.write({ type: 'interrupted', requestId: control.requestId, result });
      continue;
    }
    if (control.type === 'snapshot') {
      const snapshot = await config.harness.snapshot(control.conversationId);
      await config.write({ type: 'snapshot', requestId: control.requestId, snapshot });
      continue;
    }
    const result = await config.harness.close({
      ...(control.gracePeriodMs !== undefined && {
        gracePeriodMs: control.gracePeriodMs,
      }),
      ...(control.forceTimeoutMs !== undefined && {
        forceTimeoutMs: control.forceTimeoutMs,
      }),
    });
    await config.write({ type: 'closed', requestId: control.requestId, result });
    break;
  }
  await Promise.all(terminal);
}
