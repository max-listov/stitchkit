import { writeFileSync } from 'node:fs';
import type { SqliteDatabase } from '../../src/agent-runtime/sqlite';
import { openSqliteStore } from '../support/sqlite-store';

const [filename, pidFile] = process.argv.slice(2);
if (!filename || !pidFile) throw new Error('Expected database and PID file');
writeFileSync(pidFile, String(process.pid));
const crashBeforeCommit = (database: SqliteDatabase): SqliteDatabase => ({
  ...database,
  prepare: (sql) => {
    const statement = database.prepare(sql);
    return {
      ...statement,
      run(...values) {
        const result = statement.run(...values);
        if (
          sql.includes('INSERT INTO stitchkit_agent_runtime_events') &&
          values[0] === 'copy' &&
          values[4] === 'runtime/branched'
        ) {
          // An abrupt process death after the final insert and before COMMIT.
          process.exit(77);
        }
        return result;
      },
    };
  },
});
const { sqlite } = openSqliteStore(filename, { wrap: crashBeforeCommit });
await sqlite.store.branchConversation?.({
  requestKey: 'crash',
  destinationConversationId: 'copy',
  source: { kind: 'conversation', conversationId: 'source' },
});
throw new Error('Crash injection was not reached');
