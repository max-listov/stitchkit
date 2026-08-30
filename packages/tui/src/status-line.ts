import path from 'node:path';
import type {
  AgentModelCatalogEntry,
  AgentSnapshot,
  AgentUsage,
} from 'stitchkit/agent-runtime';

export type AgentTuiStatusTone =
  | 'primary'
  | 'muted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger';

export interface AgentTuiStatusSegment {
  text: string;
  tone?: AgentTuiStatusTone;
}

export type AgentTuiStatusRows = readonly (readonly AgentTuiStatusSegment[])[];

export interface AgentTuiStatusLineContext {
  title: string;
  workspace: string;
  activity: 'READY' | 'RUNNING' | 'APPROVAL';
  sessionId: string;
  conversationId: string;
  model?: AgentModelCatalogEntry;
  snapshot: AgentSnapshot;
}

export type AgentTuiStatusLineFormatter = (
  context: AgentTuiStatusLineContext,
) => AgentTuiStatusRows;

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function knownTotal(
  usages: readonly AgentUsage[],
  field: 'inputTokens' | 'outputTokens',
): { value: number; partial: boolean } | undefined {
  if (usages.length === 0) return undefined;
  let value = 0;
  let known = 0;
  for (const usage of usages) {
    const item = usage[field];
    if (item.value === undefined) continue;
    value += item.value;
    known += 1;
  }
  if (known === 0) return undefined;
  return { value, partial: known !== usages.length };
}

function formatKnownTotal(total: { value: number; partial: boolean }): string {
  return `${total.partial ? '≥' : ''}${formatCount(total.value)}`;
}

function shortIdentity(value: string): string {
  return value.slice(0, 8);
}

/** Default rows use only model metadata and usage already durable in the snapshot. */
export const defaultAgentTuiStatusLine: AgentTuiStatusLineFormatter = (context) => {
  const usages = context.snapshot.runs
    .map(({ usage }) => usage)
    .filter((usage): usage is AgentUsage => usage !== undefined);
  const input = knownTotal(usages, 'inputTokens');
  const output = knownTotal(usages, 'outputTokens');
  const firstRow: AgentTuiStatusSegment[] = [
    {
      text: context.model?.name ?? context.model?.id ?? 'model unavailable',
      tone: 'accent',
    },
  ];
  if (context.model) {
    firstRow.push({
      text: `${formatCount(context.model.descriptor.contextWindow)} context`,
      tone: 'primary',
    });
  }
  if (input || output) {
    firstRow.push({
      text: `session ${input ? `↓${formatKnownTotal(input)}` : '↓—'} ${output ? `↑${formatKnownTotal(output)}` : '↑—'}`,
      tone: 'muted',
    });
  }
  const activityTone: AgentTuiStatusTone =
    context.activity === 'APPROVAL'
      ? 'warning'
      : context.activity === 'RUNNING'
        ? 'accent'
        : 'success';
  return [
    firstRow,
    [
      { text: path.basename(context.workspace) || context.workspace, tone: 'primary' },
      { text: shortIdentity(context.conversationId), tone: 'muted' },
      { text: context.activity.toLowerCase(), tone: activityTone },
    ],
  ];
};
