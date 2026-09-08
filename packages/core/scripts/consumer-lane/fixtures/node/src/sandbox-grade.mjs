/** A sandbox that is not there is its own refusal, and no command runs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { mountAgent } from 'stitchkit/tools';
import { proof } from './packed-sqlite.mjs';

const root = await mkdtemp(join(tmpdir(), 'stitchkit-packed-sandbox-'));
let preparations = 0;
try {
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root,
      authorize: () => true,
      executables: { echo: '/bin/echo' },
      sandbox: {
        adapter: {
          probe: () => ({ grade: 'unavailable', reason: 'packed fixture has no sandbox' }),
          prepare: () => {
            preparations += 1;
            return { executable: '/bin/false', args: [] };
          },
        },
        required: ['network-denied'],
      },
    }),
  });
  let refusal;
  try {
    await tools.run_command.execute(
      { executable: 'echo', args: ['ran'], cwd: '.' },
      { toolCallId: 'sb', messages: [], context: undefined },
    );
  } catch (error) {
    refusal = error?.output?.error;
  }
  proof(
    'sandbox grade',
    refusal === 'SANDBOX_UNAVAILABLE' && preparations === 0,
    `refusal ${refusal}, preparations ${preparations}`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
