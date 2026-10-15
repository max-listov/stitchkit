import { writeFileSync } from 'node:fs';
import { createBunSqliteAgentRuntimeStore } from '../../src/agent-runtime/sqlite-bun';

const [filename, pidFile] = process.argv.slice(2);
if (!filename || !pidFile) throw new Error('Expected database and PID file');
writeFileSync(pidFile, String(process.pid));
const sqlite = createBunSqliteAgentRuntimeStore({ filename });
const prepare = sqlite.database.prepare.bind(sqlite.database);
sqlite.database.prepare = (sql) => {
  const statement = prepare(sql);
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
};
await sqlite.store.branchConversation?.({
  requestKey: 'crash',
  destinationConversationId: 'copy',
  source: { kind: 'conversation', conversationId: 'source' },
});
throw new Error('Crash injection was not reached');
