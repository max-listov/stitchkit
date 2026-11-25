import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type AgentCodingArtifactStore,
  type AgentCodingToolAuthorization,
  AgentCodingToolAuthorizationSchema,
} from './coding-tool-contract';
import { refuseUnknownSpillReference } from './coding-tool-refusals';
import type { AgentCompanionHost } from './companion-host';
import { SqlIntegerSchema } from './sql-rows';

const SpillRowSchema = z.object({
  payload: z.instanceof(Uint8Array),
  bytes: SqlIntegerSchema.pipe(z.int().nonnegative()),
  authorization_payload: z.string().nullable(),
});
const SpillMetadataRowSchema = z.object({
  reference_id: z.string(),
  bytes: SqlIntegerSchema.pipe(z.int().nonnegative()),
  created_at: z.string(),
});

function decodeAuthorization(value: string | null): AgentCodingToolAuthorization | undefined {
  if (value === null) return undefined;
  return AgentCodingToolAuthorizationSchema.parse(JSON.parse(value));
}

/** Tool output kept beside the conversation, in a SQL store's companion host — SQLite or Postgres. */
export function createAgentSpillStore(input: {
  /** The store's companion host: `host` of the SQLite or Postgres store. */
  host: AgentCompanionHost;
  conversationId: string;
  /** The run whose tools write through this store; create one store per run in `tools()`. */
  runId?: string;
  retentionMs?: number;
  now?: () => Date;
}): AgentCodingArtifactStore & {
  search(request: {
    reference: string;
    query: string;
    maxMatches: number;
  }): Promise<readonly { line: number; text: string }[]>;
  cleanup(): Promise<{ deleted: number; bytes: number }>;
} {
  const now = input.now ?? (() => new Date());
  const { host } = input;
  const spills = host.tables.spills;
  /**
   * The one lookup all three read paths share.
   *
   * Authorization, read and search each carried their own copy of this query
   * and its refusal, so "an unknown reference refuses in words" was three
   * separate promises to keep. The scope is deliberate: `conversation_id` is
   * part of the WHERE clause, so a reference held by another conversation is
   * indistinguishable from one that was never written.
   */
  const rowFor = async (reference: string) => {
    const raw = await host.read((session) =>
      session.get(
        `SELECT payload, bytes, authorization_payload FROM ${spills}
         WHERE reference_id = ? AND conversation_id = ?`,
        [reference, input.conversationId],
      ),
    );
    if (raw === undefined) refuseUnknownSpillReference(reference);
    return SpillRowSchema.parse(raw);
  };
  const authorization = async (reference: string) =>
    decodeAuthorization((await rowFor(reference)).authorization_payload);
  const write: AgentCodingArtifactStore['write'] = async (request) => {
    const spillAuthorization =
      request.authorization === undefined
        ? undefined
        : AgentCodingToolAuthorizationSchema.parse(request.authorization);
    const reference = randomUUID();
    const createdAt = now();
    const expiresAt = input.retentionMs
      ? new Date(createdAt.getTime() + input.retentionMs).toISOString()
      : null;
    const sha256 = createHash('sha256').update(request.data).digest('hex');
    await host.transaction(input.conversationId, async (scope) => {
      await scope.run(
        `INSERT INTO ${spills} (
           reference_id, conversation_id, run_id, tool_call_id, media_type,
           bytes, sha256, created_at, expires_at, payload, authorization_payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reference,
          input.conversationId,
          input.runId ?? null,
          request.toolCallId ?? null,
          request.mediaType,
          request.data.byteLength,
          sha256,
          createdAt.toISOString(),
          expiresAt,
          request.data,
          spillAuthorization !== undefined ? JSON.stringify(spillAuthorization) : null,
        ],
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
    const row = await rowFor(request.reference);
    const rowAuthorization = decodeAuthorization(row.authorization_payload);
    return {
      data: row.payload.slice(request.offset, request.offset + request.maxBytes),
      totalBytes: row.bytes,
      ...(rowAuthorization !== undefined && { authorization: rowAuthorization }),
    };
  };
  const search = async (request: { reference: string; query: string; maxMatches: number }) => {
    const row = await rowFor(request.reference);
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
    const expired = (
      await host.read((session) =>
        session.all(
          `SELECT reference_id, bytes, created_at FROM ${spills}
           WHERE conversation_id = ? AND expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY created_at, reference_id`,
          [input.conversationId, now().toISOString()],
        ),
      )
    ).map((row) => SpillMetadataRowSchema.parse(row));
    let deleted = 0;
    let bytes = 0;
    for (const spill of expired) {
      const removed = await host.transaction(input.conversationId, async (scope) => {
        const existing = await scope.get(
          `SELECT reference_id FROM ${spills} WHERE reference_id = ? AND conversation_id = ?`,
          [spill.reference_id, input.conversationId],
        );
        if (existing === undefined) return false;
        await scope.run(
          `DELETE FROM ${spills} WHERE reference_id = ? AND conversation_id = ?`,
          [spill.reference_id, input.conversationId],
        );
        await scope.appendEvent({
          conversationId: input.conversationId,
          kind: 'spill/deleted',
          payload: { reference: spill.reference_id, bytes: spill.bytes },
        });
        return true;
      });
      if (removed) {
        deleted += 1;
        bytes += spill.bytes;
      }
    }
    return { deleted, bytes };
  };
  return { authorization, write, read, search, cleanup };
}
