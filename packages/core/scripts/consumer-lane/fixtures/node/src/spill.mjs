/** An oversized shell result spills whole, and the model gets head, tail and a locator. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAgentSpillStore } from 'stitchkit/agent-runtime';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { mountAgent } from 'stitchkit/tools';
import { packedSqlite, proof } from './packed-sqlite.mjs';

const { handle } = packedSqlite();
const root = await mkdtemp(join(tmpdir(), 'stitchkit-packed-spill-'));
try {
  const spills = createSqliteAgentSpillStore({
    sqlite: handle,
    conversationId: 'spill',
  });
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root,
      authorize: () => true,
      executables: { seq: '/usr/bin/seq' },
      artifacts: spills,
      limits: { maxShellOutputBytes: 4_096 },
    }),
  });
  const execute = (name) => tools[name].execute;
  const options = { toolCallId: 'spill', messages: [], context: undefined };
  const result = await execute('run_command')(
    { executable: 'seq', args: ['1', '200000'], cwd: '.' },
    options,
  );
  const reference = result?.artifact?.reference;
  const found = reference
    ? await execute('search_output')({ reference, query: '199999', maxMatches: 5 }, options)
    : undefined;
  const preview = `${result?.stdout ?? ''}`;
  proof(
    'spill',
    Boolean(reference) &&
      result.artifact.omittedBytes > 0 &&
      preview.length <= 4_096 &&
      preview.startsWith('1\n') &&
      preview.trimEnd().endsWith('200000') &&
      Array.isArray(found?.matches) &&
      found.matches.some((match) => match.text === '199999'),
    `reference ${reference}, artifact ${JSON.stringify(result?.artifact)}, preview ${preview.length} bytes, found ${JSON.stringify(found).slice(0, 160)}`,
  );
} finally {
  await handle.close();
  await rm(root, { recursive: true, force: true });
}
