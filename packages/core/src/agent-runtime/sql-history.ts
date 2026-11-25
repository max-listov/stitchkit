import { AgentMessageSchema } from './schemas';
import {
  CountRowSchema,
  encodeJson,
  MessageRowSchema,
  missing,
  PositionedMessageRowSchema,
  parseJson,
  placeholders,
  type SqlStoreDriver,
} from './sql-rows';
import type { AgentSqlDialect } from './sql-session';
import { AgentHistoryMutationSchema } from './store-driver-contract';

/**
 * The conversation's message rows: the active view the model reads, and the
 * compacted rows it no longer does, which stay for a person reading back.
 */
export function sqlHistory(dialect: AgentSqlDialect): SqlStoreDriver['history'] {
  const messages = dialect.tables.messages;
  const insert = `INSERT INTO ${messages} (conversation_id, id, position, active, payload)
    VALUES (?, ?, ?, ?, ?)`;
  return {
    async restore(transaction, input) {
      const compacted = new Set(input.compactedMessageIds);
      for (const [position, message] of input.messages.entries()) {
        if (message.conversationId !== input.conversationId)
          throw new TypeError('Restored history has a foreign conversation');
        await transaction.run(insert, [
          input.conversationId,
          message.id,
          position,
          compacted.has(message.id) ? 0 : 1,
          encodeJson(message),
        ]);
      }
    },
    async load(transaction, conversationId) {
      const rows = await transaction.all(
        `SELECT payload FROM ${messages}
         WHERE conversation_id = ? AND active = 1 ORDER BY position ASC`,
        [conversationId],
      );
      return rows.map((value) =>
        AgentMessageSchema.parse(parseJson(MessageRowSchema.parse(value).payload)),
      );
    },
    async hasMessage(transaction, input) {
      // Deliberately ignores `active`: a compacted seed still occupies its
      // `(conversation_id, id)` row, and the seed write is idempotent against
      // it whether or not the active view shows it.
      const row = await transaction.get(
        `SELECT count(*) AS count FROM ${messages} WHERE conversation_id = ? AND id = ?`,
        [input.conversationId, input.messageId],
      );
      return CountRowSchema.parse(row).count > 0;
    },
    async apply(transaction, rawMutation) {
      const mutation = AgentHistoryMutationSchema.parse(rawMutation);
      const message =
        mutation.type === 'admit'
          ? mutation.input
          : mutation.type === 'replace-compacted-range'
            ? mutation.summary
            : mutation.message;
      if (mutation.type === 'seed') {
        // Prepended, so user instructions lead the conversation they seed.
        // The reducer emits these front-most-first, so each prepend lands
        // ahead of the previous one and the persisted order matches.
        await transaction.run(
          `UPDATE ${messages} SET position = position + 1 WHERE conversation_id = ?`,
          [message.conversationId],
        );
        await transaction.run(
          `INSERT INTO ${messages} (conversation_id, id, position, active, payload)
           VALUES (?, ?, 0, 1, ?)
           ON CONFLICT (conversation_id, id) DO UPDATE SET
             position = excluded.position,
             active = excluded.active,
             payload = excluded.payload`,
          [message.conversationId, message.id, encodeJson(message)],
        );
        return;
      }
      if (mutation.type === 'replace-compacted-range') {
        const parameters = mutation.replacedMessageIds;
        const rows = (
          await transaction.all(
            `SELECT position FROM ${messages}
             WHERE conversation_id = ? AND active = 1 AND id IN (${placeholders(parameters.length)})
             ORDER BY position ASC`,
            [message.conversationId, ...parameters],
          )
        ).map((row) => PositionedMessageRowSchema.parse(row));
        // The summary takes the position of the LAST message it replaces, not
        // the first. Both put it in the same place in the model's history —
        // every replaced row is inactive — and they differ once a reader asks
        // for the compacted messages too: anchored at the last, the block reads
        // through and the summary arrives after it, where it was written.
        const anchor = rows.at(-1);
        if (!anchor || rows.length !== parameters.length) {
          throw new Error('Compaction range changed inside the transaction');
        }
        await transaction.run(
          `UPDATE ${messages} SET active = 0
           WHERE conversation_id = ? AND id IN (${placeholders(parameters.length)})`,
          [message.conversationId, ...parameters],
        );
        await transaction.run(insert, [
          message.conversationId,
          message.id,
          anchor.position,
          1,
          encodeJson(message),
        ]);
        return;
      }
      const existing = await transaction.get(
        `SELECT position FROM ${messages} WHERE conversation_id = ? AND id = ?`,
        [message.conversationId, message.id],
      );
      if (mutation.type === 'insert' && missing(existing) && mutation.beforeMessageId) {
        const anchor = await transaction.get(
          `SELECT position FROM ${messages} WHERE conversation_id = ? AND id = ? AND active = 1`,
          [message.conversationId, mutation.beforeMessageId],
        );
        if (missing(anchor)) throw new Error('Insert anchor is not in the active history');
        const { position } = PositionedMessageRowSchema.parse(anchor);
        await transaction.run(
          `UPDATE ${messages} SET position = position + 1
           WHERE conversation_id = ? AND position >= ?`,
          [message.conversationId, position],
        );
        await transaction.run(insert, [
          message.conversationId,
          message.id,
          position,
          1,
          encodeJson(message),
        ]);
        return;
      }
      if (!missing(existing)) {
        await transaction.run(
          `UPDATE ${messages} SET payload = ?, active = 1 WHERE conversation_id = ? AND id = ?`,
          [encodeJson(message), message.conversationId, message.id],
        );
        return;
      }
      const last = await transaction.get(
        `SELECT position FROM ${messages} WHERE conversation_id = ?
         ORDER BY position DESC LIMIT 1`,
        [message.conversationId],
      );
      const position = missing(last) ? 0 : PositionedMessageRowSchema.parse(last).position + 1;
      await transaction.run(insert, [
        message.conversationId,
        message.id,
        position,
        1,
        encodeJson(message),
      ]);
    },
  };
}
