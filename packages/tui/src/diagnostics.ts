import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createDiagnosticJournal, type DiagnosticJournal } from 'stitchkit/application';
import { z } from 'zod';
import type { AgentTuiDiagnostics } from './config';
import { listAgentTuiSessions } from './session';

const RUNTIME_EVENT_TYPES = new Set([
  'admission',
  'run-state',
  'terminal',
  'tool-status',
  'run-started',
  'run-terminal',
  'step-finished',
]);
const MAX_SESSION_JOURNALS = 8;

const BaseEventSchema = z.object({
  schemaVersion: z.literal(1),
  occurredAt: z.iso.datetime({ offset: true }),
});

export const AgentTuiDiagnosticEventSchema = z.discriminatedUnion('type', [
  BaseEventSchema.extend({
    type: z.literal('host-started'),
    sessionId: z.string().min(8),
    conversationId: z.string().min(1),
    launchMode: z.enum(['fresh', 'explicit']),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal('conversation-changed'),
    sessionId: z.string().min(8),
    previousConversationId: z.string().min(1),
    conversationId: z.string().min(1),
    reason: z.enum(['new', 'clear', 'resume']),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal('submission-admitted'),
    sessionId: z.string().min(8),
    conversationId: z.string().min(1),
    runId: z.string().min(1),
    source: z.enum(['terminal', 'client']),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal('runtime-event'),
    conversationId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    eventType: z.string().min(1),
    state: z.string().min(1).optional(),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal('request-failed'),
    sessionId: z.string().min(8),
    operation: z.enum(['status', 'submit', 'interrupt']),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal('host-closed'),
    sessionId: z.string().min(8),
    conversationId: z.string().min(1),
  }).strict(),
]);
export type AgentTuiDiagnosticEvent = z.infer<typeof AgentTuiDiagnosticEventSchema>;

export interface AgentTuiDiagnosticRecorder extends AgentTuiDiagnostics {
  record(event: AgentTuiDiagnosticEvent): void;
  close(): Promise<void>;
}

function stringField(value: object, name: string): string | undefined {
  const field = Reflect.get(value, name);
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** Reduce runtime diagnostics to identifiers and state transitions before they touch disk. */
export function projectAgentTuiRuntimeDiagnostic(
  value: unknown,
  occurredAt = new Date().toISOString(),
): AgentTuiDiagnosticEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const nested = Reflect.get(value, 'event');
  const event = typeof nested === 'object' && nested !== null ? nested : value;
  const eventType = stringField(event, 'type');
  if (!eventType || !RUNTIME_EVENT_TYPES.has(eventType)) return undefined;
  const conversationId =
    stringField(value, 'conversationId') ?? stringField(event, 'conversationId');
  const runId = stringField(value, 'runId') ?? stringField(event, 'runId');
  const state = stringField(event, 'state');
  return AgentTuiDiagnosticEventSchema.parse({
    schemaVersion: 1,
    occurredAt,
    type: 'runtime-event',
    ...(conversationId && { conversationId }),
    ...(runId && { runId }),
    eventType,
    ...(state && { state }),
  });
}

async function pruneOldSessionJournals(input: {
  directory: string;
  workspace: string;
  currentSessionId: string;
}): Promise<void> {
  const liveSessionIds = new Set(
    (await listAgentTuiSessions(input.workspace)).map(({ sessionId }) => sessionId),
  );
  liveSessionIds.add(input.currentSessionId);
  const groups = new Map<string, { files: string[]; modifiedAt: number }>();
  for (const name of await readdir(input.directory)) {
    const match = /^([a-f0-9]{16})\.jsonl(?:\.\d+|\.lock)?$/.exec(name);
    const sessionId = match?.[1];
    if (!sessionId || liveSessionIds.has(sessionId)) continue;
    const filename = path.join(input.directory, name);
    const info = await lstat(filename);
    if (!info.isFile()) continue;
    const group = groups.get(sessionId) ?? { files: [], modifiedAt: 0 };
    group.files.push(filename);
    group.modifiedAt = Math.max(group.modifiedAt, info.mtimeMs);
    groups.set(sessionId, group);
  }
  const inactive = [...groups.values()].sort(
    (left, right) => right.modifiedAt - left.modifiedAt,
  );
  for (const group of inactive.slice(MAX_SESSION_JOURNALS)) {
    for (const filename of group.files) await rm(filename);
  }
}

export async function createAgentTuiDiagnosticRecorder(input: {
  workspace: string;
  sessionId: string;
}): Promise<AgentTuiDiagnosticRecorder> {
  const directory = path.join(input.workspace, '.stitchkit', 'logs', 'tui');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const basename = `${input.sessionId}.jsonl`;
  await pruneOldSessionJournals({
    directory,
    workspace: input.workspace,
    currentSessionId: input.sessionId,
  });
  const journal: DiagnosticJournal<AgentTuiDiagnosticEvent> = await createDiagnosticJournal({
    path: path.join(directory, basename),
    eventSchema: AgentTuiDiagnosticEventSchema,
    limits: {
      maxEventBytes: 4_096,
      maxPendingItems: 256,
      maxPendingBytes: 256 * 4_096,
      maxFileBytes: 512 * 1_024,
      maxFiles: 2,
    },
  });
  return {
    write(value) {
      const event = projectAgentTuiRuntimeDiagnostic(value);
      if (event) journal.submit(event);
    },
    record(event) {
      journal.submit(event);
    },
    async close() {
      await journal.close({ timeoutMs: 2_000 });
    },
  };
}
