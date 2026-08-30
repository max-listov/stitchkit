import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const workspace = await mkdtemp(join(tmpdir(), 'stitchkit-tui-packed-'));
const artifacts = join(workspace, 'artifacts');
const consumer = join(workspace, 'consumer');

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(' ')} failed with ${code}\n${stdout}${stderr}`);
  }
  return stdout;
}

async function archive(prefix: string): Promise<string> {
  const match = (await readdir(artifacts)).find(
    (entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'),
  );
  if (!match) throw new Error(`packed archive ${prefix}*.tgz was not produced`);
  return join(artifacts, match);
}

try {
  await run(['mkdir', '-p', artifacts, consumer], root);
  await run(['bun', 'pm', 'pack', '--destination', artifacts], join(root, 'packages/core'));
  await run(['bun', 'pm', 'pack', '--destination', artifacts], join(root, 'packages/tui'));

  const coreArchive = await archive('stitchkit-0.');
  const tuiArchive = await archive('stitchkit-tui-');
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'stitchkit-tui-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          'stitchkit-tui': `file:${tuiArchive}`,
          stitchkit: `file:${coreArchive}`,
          typescript: '^7.0.0',
        },
        overrides: {
          stitchkit: `file:${coreArchive}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumer, 'probe.ts'),
    `import { defineAgentTui, listAgentTuiSessions } from 'stitchkit-tui';\n` +
      `import { createTerminalCollection, reduceTerminalCollection, createTerminalPaneState, visibleTerminalPanes } from 'stitchkit-tui/core';\n` +
      `import { searchAgentModelCatalog } from 'stitchkit/agent-runtime';\n` +
      `const config = defineAgentTui({ title: 'Packed probe', context: () => ({}), modelCatalog: { load: async () => ({ schemaVersion: 1, source: 'probe', observedAt: new Date().toISOString(), completeness: 'complete', diagnostics: [], models: [] }) }, createRuntime: async () => { throw new Error('not started'); } });\n` +
      `if (config.title !== 'Packed probe') throw new Error('config export failed');\n` +
      `if ((await listAgentTuiSessions('.runtime')).length !== 0) throw new Error('session reader failed');\n` +
      `if (typeof searchAgentModelCatalog !== 'function') throw new Error('runtime export failed');\n` +
      `let collection = createTerminalCollection(['one', 'two'], 1, 'two');\n` +
      `collection = reduceTerminalCollection(collection, { type: 'reconcile', keys: ['two', 'one'] });\n` +
      `if (collection.selectedKey !== 'two') throw new Error('selection identity drifted');\n` +
      `const panes = createTerminalPaneState({ totalSize: 60, primarySize: 30, minPrimary: 20, minSecondary: 20, mode: 'single', focus: 'secondary' });\n` +
      `if (visibleTerminalPanes(panes).join(',') !== 'secondary') throw new Error('single-pane projection failed');\n` +
      `console.log('packed TUI consumer: ok');\n`,
  );
  await writeFile(
    join(consumer, 'core-probe.mjs'),
    `import { createTerminalCollection, reduceTerminalCollection } from 'stitchkit-tui/core';\n` +
      `let state = createTerminalCollection(['a', 'b', 'c'], 2, 'b');\n` +
      `state = reduceTerminalCollection(state, { type: 'reconcile', keys: ['c', 'b', 'a'] });\n` +
      `if (state.selectedKey !== 'b') throw new Error('Node core selection drifted');\n` +
      `console.log('packed TUI core Node consumer: ok');\n`,
  );
  const ptyFixture = `import { defineAgentTui } from 'stitchkit-tui';
import { AgentSnapshotSchema, type AgentRuntimeInput } from 'stitchkit/agent-runtime';
import type { AgentHarnessApprovalDecision, HeadlessAgentHarness } from 'stitchkit/agent-runtime/harness';
const at = new Date().toISOString();
const snapshot = (conversationId: string) => AgentSnapshotSchema.parse({ schemaVersion: 1, conversationId, version: 0, messages: [], runs: [] });
const harness: HeadlessAgentHarness<Record<string, never>> = {
  submit(_input: AgentRuntimeInput<Record<string, never>>) { throw new Error('PTY fixture does not submit'); },
  resume() { throw new Error('PTY fixture does not resume'); },
  async interrupt() { throw new Error('PTY fixture does not interrupt'); },
  async recover() { return []; },
  stop() { return false; },
  async close() { return { settled: true, timedOut: false, remaining: 0 }; },
  async snapshot(conversationId: string) { return snapshot(conversationId); },
  subscribe() { return () => undefined; },
  async pendingApprovals() { return []; },
  async respondToApproval(_input: AgentHarnessApprovalDecision<Record<string, never>>) { throw new Error('PTY fixture has no approvals'); },
};
export default defineAgentTui({
  title: 'PTY fixture', workspace: process.cwd(), context: () => ({}),
  modelCatalog: { load: async () => ({ schemaVersion: 1, source: 'pty-fixture', observedAt: at, completeness: 'complete', diagnostics: [], models: [{ id: 'fixture/model', name: 'Fixture model', descriptor: { provider: 'fixture', modelId: 'model', contextWindow: 32000, capabilities: ['tools'] }, metrics: [] }] }) },
  createRuntime: () => ({ harness }),
});
`;
  await writeFile(join(consumer, 'stitchkit.agent.ts'), ptyFixture);
  await writeFile(
    join(consumer, 'stitchkit.agent-failing.ts'),
    ptyFixture.replace(
      'async close() { return { settled: true, timedOut: false, remaining: 0 }; }',
      "async close() { throw new Error('fixture close failure'); }",
    ),
  );

  await run(['bun', 'install', '--ignore-scripts'], consumer);
  const manifestText = await run(
    ['tar', '-xOf', tuiArchive, 'package/package.json'],
    consumer,
  );
  if (manifestText.includes('workspace:'))
    throw new Error('packed TUI manifest retains workspace protocol');
  const contents = await run(['tar', '-tzf', tuiArchive], consumer);
  if (!contents.includes('package/dist/cli.js'))
    throw new Error('packed TUI archive omits its CLI');
  if (!contents.includes('package/dist/core/index.js'))
    throw new Error('packed TUI archive omits its core entrypoint');
  await run(
    [
      'bun',
      'x',
      'tsc',
      '--noEmit',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      'probe.ts',
    ],
    consumer,
  );
  const probe = await run(['bun', 'probe.ts'], consumer);
  const nodeProbe = await run(['node', 'core-probe.mjs'], consumer);
  const cli = await run(['bun', 'node_modules/.bin/stitchkit-agent', 'sessions'], consumer);
  if (!probe.includes('packed TUI consumer: ok'))
    throw new Error('packed import probe was silent');
  if (cli.trim() !== '')
    throw new Error(`fresh packed CLI unexpectedly listed sessions: ${cli}`);
  if (!nodeProbe.includes('packed TUI core Node consumer: ok'))
    throw new Error('packed Node core import probe was silent');
  await run(
    [
      'bash',
      '-lc',
      `(sleep 1; printf '\\003') | timeout 10s script -qec 'bun node_modules/.bin/stitchkit-agent run --config stitchkit.agent.ts' /dev/null`,
    ],
    consumer,
  );
  const afterExit = await run(
    ['bun', 'node_modules/.bin/stitchkit-agent', 'sessions'],
    consumer,
  );
  if (afterExit.trim() !== '') throw new Error('PTY host left a discoverable live session');
  const sessionDirectory = join(consumer, '.stitchkit', 'tui', 'sessions');
  const leftovers = await readdir(sessionDirectory).catch(() => []);
  if (leftovers.some((entry) => entry.endsWith('.json') || entry.endsWith('.sock')))
    throw new Error(`PTY host left local session artifacts: ${leftovers.join(', ')}`);
  await run(
    [
      'bash',
      '-lc',
      `(sleep 1; printf '\\003') | timeout 10s script -qec 'bun node_modules/.bin/stitchkit-agent run --config stitchkit.agent-failing.ts' /dev/null`,
    ],
    consumer,
  );
  const failureLeftovers = await readdir(sessionDirectory).catch(() => []);
  if (failureLeftovers.some((entry) => entry.endsWith('.json') || entry.endsWith('.sock')))
    throw new Error(
      `Failed PTY close left local session artifacts: ${failureLeftovers.join(', ')}`,
    );
  process.stdout.write('tui-packed-lane: ok\n');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
