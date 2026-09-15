import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentCodingArtifactStore,
  AgentCodingToolAuthorization,
} from './coding-tool-contract';
import { refuseUnknownSpillReference } from './coding-tool-refusals';
import type { SqliteAgentRuntimeStore } from './sqlite';

const SpillRowSchema = z.object({
  payload: z.instanceof(Uint8Array),
  bytes: z.int().nonnegative(),
  authorization_payload: z.string().nullable(),
});
const SpillMetadataRowSchema = z.object({
  reference_id: z.string(),
  bytes: z.int().nonnegative(),
  created_at: z.string(),
});

function decodeAuthorization(value: string | null): AgentCodingToolAuthorization | undefined {
  if (value === null) return undefined;
  return JSON.parse(value);
}

export function createSqliteAgentSpillStore(input: {
  sqlite: SqliteAgentRuntimeStore;
  conversationId: string;
  runId?: string;
  toolCallId?: string;
  retentionMs?: number;
  now?: () => Date;
}): AgentCodingArtifactStore & {
  search(request: { reference: string; query: string; maxMatches: number }): readonly {
    line: number;
    text: string;
  }[];
  cleanup(): Promise<{ deleted: number; bytes: number }>;
} {
  const now = input.now ?? (() => new Date());
  const database = input.sqlite.database;
  /**
   * The one lookup all three read paths share.
   *
   * Authorization, read and search each carried their own copy of this query
   * and its refusal, so "an unknown reference refuses in words" was three
   * separate promises to keep. The scope is deliberate: `conversation_id` is
   * part of the WHERE clause, so a reference held by another conversation is
   * indistinguishable from one that was never written.
   */
  const rowFor = (reference: string) => {
    const raw = database
      .prepare(`
        SELECT payload, bytes, authorization_payload
        FROM stitchkit_agent_runtime_spills
        WHERE reference_id = ? AND conversation_id = ?
      `)
      .get(reference, input.conversationId);
    if (raw === null || raw === undefined) refuseUnknownSpillReference(reference);
    return SpillRowSchema.parse(raw);
  };
  const authorization = (reference: string) =>
    decodeAuthorization(rowFor(reference).authorization_payload);
  const write: AgentCodingArtifactStore['write'] = async (request) => {
    const reference = randomUUID();
    const createdAt = now();
    const expiresAt = input.retentionMs
      ? new Date(createdAt.getTime() + input.retentionMs).toISOString()
      : null;
    const sha256 = createHash('sha256').update(request.data).digest('hex');
    await input.sqlite.transaction(async (scope) => {
      scope.database
        .prepare(`
          INSERT INTO stitchkit_agent_runtime_spills (
            reference_id, conversation_id, run_id, tool_call_id, media_type,
            bytes, sha256, created_at, expires_at, payload, authorization_payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          reference,
          input.conversationId,
          input.runId ?? null,
          input.toolCallId ?? null,
          request.mediaType,
          request.data.byteLength,
          sha256,
          createdAt.toISOString(),
          expiresAt,
          request.data,
          request.authorization ? JSON.stringify(request.authorization) : null,
        );
      await scope.appendEvent({
        conversationId: input.conversationId,
        kind: 'spill/created',
        occurredAt: createdAt.toISOString(),
        payload: { reference, bytes: request.data.byteLength, sha256 },
      });
    });
    return { reference };
  };
  const read: AgentCodingArtifactStore['read'] = async (request) => {
    const row = rowFor(request.reference);
    return {
      data: row.payload.slice(request.offset, request.offset + request.maxBytes),
      totalBytes: row.bytes,
      ...(decodeAuthorization(row.authorization_payload) && {
        authorization: decodeAuthorization(row.authorization_payload),
      }),
    };
  };
  const search = (request: { reference: string; query: string; maxMatches: number }) => {
    const row = rowFor(request.reference);
    const matches: { line: number; text: string }[] = [];
    new TextDecoder('utf-8', { fatal: true })
      .decode(row.payload)
      .split('\n')
      .forEach((text, index) => {
        if (matches.length < request.maxMatches && text.includes(request.query)) {
          matches.push({ line: index + 1, text });
        }
      });
    return matches;
  };
  const cleanup = async () => {
    const expired = database
      .prepare(`
        SELECT reference_id, bytes, created_at
        FROM stitchkit_agent_runtime_spills
        WHERE conversation_id = ? AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY created_at, reference_id
      `)
      .all(input.conversationId, now().toISOString())
      .map((row) => SpillMetadataRowSchema.parse(row));
    let bytes = 0;
    for (const spill of expired) {
      await input.sqlite.transaction(async (scope) => {
        scope.database
          .prepare('DELETE FROM stitchkit_agent_runtime_spills WHERE reference_id = ?')
          .run(spill.reference_id);
        await scope.appendEvent({
          conversationId: input.conversationId,
          kind: 'spill/deleted',
          payload: { reference: spill.reference_id, bytes: spill.bytes },
        });
      });
      bytes += spill.bytes;
    }
    return { deleted: expired.length, bytes };
  };
  return { authorization, write, read, search, cleanup };
}
