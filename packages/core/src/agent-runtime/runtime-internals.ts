import type { LanguageModelUsage } from 'ai';
import { z } from 'zod';
import {
  AgentJsonObjectSchema,
  type AgentMessagePart,
  AgentMessagePartSchema,
  type AgentRun,
  type AgentTerminalReason,
  type AgentUsage,
} from './schemas';
import { AgentRuntimeConflictError } from './terminal-commit';

/**
 * Pure helpers shared by the runtime factory and the run executor.
 *
 * They live apart from both so neither has to import the other: the factory
 * wires dependencies, the executor runs one turn, and these belong to neither.
 */

export function findRun(runs: readonly AgentRun[], runId: string): AgentRun {
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) throw new AgentRuntimeConflictError('run lookup');
  return run;
}

export function jsonValue(value: unknown): z.infer<ReturnType<typeof z.json>> {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : { message: 'Non-JSON tool output omitted' };
}

export function providerEnvelope(value: unknown) {
  const parsed = AgentJsonObjectSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { schemaVersion: 1, provider: 'ai-sdk', data: parsed.data };
}

export function appendText(parts: AgentMessagePart[], text: string): void {
  const previous = parts.at(-1);
  if (previous?.type === 'text') {
    const next = AgentMessagePartSchema.parse({ ...previous, text: previous.text + text });
    parts.splice(parts.length - 1, 1, next);
    return;
  }
  parts.push(AgentMessagePartSchema.parse({ type: 'text', text }));
}

export function abortTerminalReason(signal: AbortSignal): AgentTerminalReason {
  if (signal.reason === 'shutdown') return 'shutdown';
  if (signal.reason === 'timeout') return 'timeout';
  return 'interrupted';
}

export function normalizeSdkUsage(value: LanguageModelUsage): AgentUsage {
  const reported = (tokens: number | undefined): AgentUsage['inputTokens'] =>
    tokens === undefined
      ? { provenance: 'unavailable' }
      : { value: tokens, provenance: 'provider-reported' };
  return {
    inputTokens: reported(value.inputTokens),
    outputTokens: reported(value.outputTokens),
    reasoningTokens: reported(value.outputTokenDetails.reasoningTokens),
    cacheReadTokens: reported(value.inputTokenDetails.cacheReadTokens),
    cacheWriteTokens: reported(value.inputTokenDetails.cacheWriteTokens),
  };
}

export function createIdleDeadline(parent: AbortSignal, timeoutMs: number | undefined) {
  if (timeoutMs === undefined) {
    const noop = (): void => undefined;
    return { signal: parent, touch: noop, dispose: noop };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  };
  touch();
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    touch,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
