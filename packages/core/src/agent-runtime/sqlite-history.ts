import { AgentMessageSchema } from './schemas';
import {
  CountRowSchema,
  encodeJson,
  MessageRowSchema,
  missing,
  PositionedMessageRowSchema,
  parseJson,
  placeholders,
  type SqliteStoreDriver,
} from './sqlite-rows';
import { AgentHistoryMutationSchema } from './store-driver-contract';

/**
 * The conversation's message rows: the active view the model reads, and the
 * compacted rows it no longer does, which stay for a person reading back.
 */
export const sqliteHistory: SqliteStoreDriver['history'] = {
  async load(transaction, conversationId) {
    return transaction
      .prepare(`
        SELECT payload FROM stitchkit_agent_runtime_messages
        WHERE conversation_id = ? AND active = 1 ORDER BY position ASC
      `)
      .all(conversationId)
      .map((value) =>
        AgentMessageSchema.parse(parseJson(MessageRowSchema.parse(value).payload)),
      );
  },
  async hasMessage(transaction, input) {
    // Deliberately ignores `active`: a compacted seed still occupies its
    // `(conversation_id, id)` row, and the seed write is idempotent against
    // it whether or not the active view shows it.
    const row = transaction
      .prepare(`
        SELECT count(*) AS count FROM stitchkit_agent_runtime_messages
        WHERE conversation_id = ? AND id = ?
      `)
      .get(input.conversationId, input.messageId);
    return CountRowSchema.parse(row).count > 0;
  },
  async apply(transaction, rawMutation) {
    const mutation = AgentHistoryMutationSchema.parse(rawMutation);
    const message =
      mutation.type === 'admit'
        ? mutation.input
        : mutation.type === 'upsert-assistant'
          ? mutation.message
          : mutation.type === 'seed'
            ? mutation.message
            : mutation.summary;
    if (mutation.type === 'seed') {
      // Prepended, so user instructions lead the conversation they seed.
      // The reducer emits these front-most-first, so each prepend lands
      // ahead of the previous one and the persisted order matches.
      transaction
        .prepare(`
          UPDATE stitchkit_agent_runtime_messages SET position = position + 1
          WHERE conversation_id = ?
        `)
        .run(mutation.message.conversationId);
      transaction
        .prepare(`
          INSERT INTO stitchkit_agent_runtime_messages
            (conversation_id, id, position, active, payload)
          VALUES (?, ?, 0, 1, ?)
          ON CONFLICT (conversation_id, id) DO UPDATE SET
            position = excluded.position,
            active = excluded.active,
            payload = excluded.payload
        `)
        .run(
          mutation.message.conversationId,
          mutation.message.id,
          encodeJson(mutation.message),
        );
      return;
    }
    if (mutation.type === 'replace-compacted-range') {
      const parameters = mutation.replacedMessageIds;
      const rows = transaction
        .prepare(`
          SELECT position FROM stitchkit_agent_runtime_messages
          WHERE conversation_id = ? AND active = 1
            AND id IN (${placeholders(parameters.length)})
          ORDER BY position ASC
        `)
        .all(message.conversationId, ...parameters)
        .map((row) => PositionedMessageRowSchema.parse(row));
      // The summary takes the position of the LAST message it replaces, not
      // the first.
      //
      // Both put it in the same place in the model's history — every
      // replaced row is inactive, so nothing active sits between them —
      // and the two differ only once a reader asks for the compacted
      // messages too. Anchored at the first, the summary landed between
      // the message it summarizes and the rest of the block: a person read
      // one message, then a retelling of the next ten, then those ten.
      // Anchored at the last, the block reads through and the summary
      // arrives after it, where it was written.
      const anchor = rows.at(-1);
      if (!anchor || rows.length !== parameters.length) {
        throw new Error('Compaction range changed inside the transaction');
      }
      transaction
        .prepare(`
          UPDATE stitchkit_agent_runtime_messages SET active = 0
          WHERE conversation_id = ? AND id IN (${placeholders(parameters.length)})
        `)
        .run(message.conversationId, ...parameters);
      transaction
        .prepare(`
          INSERT INTO stitchkit_agent_runtime_messages
            (conversation_id, id, position, active, payload)
          VALUES (?, ?, ?, 1, ?)
        `)
        .run(message.conversationId, message.id, anchor.position, encodeJson(message));
      return;
    }
    const existing = transaction
      .prepare(`
        SELECT position FROM stitchkit_agent_runtime_messages
        WHERE conversation_id = ? AND id = ?
      `)
      .get(message.conversationId, message.id);
    if (!missing(existing)) {
      transaction
        .prepare(`
          UPDATE stitchkit_agent_runtime_messages SET payload = ?, active = 1
          WHERE conversation_id = ? AND id = ?
        `)
        .run(encodeJson(message), message.conversationId, message.id);
      return;
    }
    const last = transaction
      .prepare(`
        SELECT position FROM stitchkit_agent_runtime_messages
        WHERE conversation_id = ? ORDER BY position DESC LIMIT 1
      `)
      .get(message.conversationId);
    const position = missing(last) ? 0 : PositionedMessageRowSchema.parse(last).position + 1;
    transaction
      .prepare(`
        INSERT INTO stitchkit_agent_runtime_messages
          (conversation_id, id, position, active, payload)
        VALUES (?, ?, ?, 1, ?)
      `)
      .run(message.conversationId, message.id, position, encodeJson(message));
  },
};
