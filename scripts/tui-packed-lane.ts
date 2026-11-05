import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const workspace = await mkdtemp(join(tmpdir(), 'stitchkit-tui-packed-'));
const artifacts = join(workspace, 'artifacts');
const consumer = join(workspace, 'consumer');
const monitorConsumer = join(workspace, 'monitor-consumer');

/** The renderer and React the kit expects from its consumer: one copy, the project's own. */
const tuiManifest: unknown = JSON.parse(
  await Bun.file(join(root, 'packages/tui/package.json')).text(),
);
function peerRange(name: string): string {
  const peers =
    typeof tuiManifest === 'object' && tuiManifest !== null
      ? Reflect.get(tuiManifest, 'peerDependencies')
      : undefined;
  const range =
    typeof peers === 'object' && peers !== null ? Reflect.get(peers, name) : undefined;
  if (typeof range !== 'string') throw new Error(`stitchkit-tui declares no peer ${name}`);
  return range;
}
const rendererPeers = {
  '@opentui/core': peerRange('@opentui/core'),
  '@opentui/react': peerRange('@opentui/react'),
  react: peerRange('react'),
};

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
  await run(['mkdir', '-p', artifacts, consumer, monitorConsumer], root);
  await run(
    [
      'bun',
      '../../scripts/package-build-lock.ts',
      '--',
      'bun',
      'pm',
      'pack',
      '--destination',
      artifacts,
    ],
    join(root, 'packages/core'),
  );
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
          ...rendererPeers,
          typescript: '^7.0.0',
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

  // A monitor with no agent runtime: only the kit, the renderer and React.
  await writeFile(
    join(monitorConsumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'stitchkit-tui-monitor-consumer',
        private: true,
        type: 'module',
        dependencies: { 'stitchkit-tui': `file:${tuiArchive}`, ...rendererPeers },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(monitorConsumer, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@opentui/react' } })}\n`,
  );
  await writeFile(
    join(monitorConsumer, 'probe.tsx'),
    `import { terminalNativeTarget } from 'stitchkit-tui/build';\n` +
      `import { createTerminalTable } from 'stitchkit-tui/core';\n` +
      `import { renderTerminalTest } from 'stitchkit-tui/testing';\n` +
      `import { TerminalMeter, TerminalTable } from 'stitchkit-tui/widgets';\n` +
      `const table = createTerminalTable({ columns: [{ id: 'name', title: 'NAME', kind: 'text', width: { flex: 1 } }, { id: 'cpu', title: 'CPU%', kind: 'number', width: 6 }], rows: [{ key: 'a', cells: { name: 'packed-row', cpu: 12.5 } }], capacity: 3, sort: { columnId: 'cpu', direction: 'desc' } });\n` +
      `if (terminalNativeTarget('bun-linux-x64').packageName !== '@opentui/core-linux-x64') throw new Error('packed build entry failed');\n` +
      `const screen = await renderTerminalTest(<box style={{ flexDirection: 'column' }}><TerminalMeter label="cpu0" value={50} max={100} width={30} /><TerminalTable state={table} onAction={() => {}} width={40} height={5} /></box>, { width: 40, height: 6 });\n` +
      'const frame = await screen.frame();\n' +
      'await screen.close();\n' +
      `for (const text of ['cpu0', '50.0%', 'packed-row', 'CPU%▼', '1 row']) if (!frame.includes(text)) throw new Error('packed widgets frame lacks ' + text + ':\\n' + frame);\n` +
      `console.log('packed TUI widgets consumer: ok');\n`,
  );

  await run(['bun', 'install', '--ignore-scripts'], consumer);
  await run(['bun', 'install', '--ignore-scripts'], monitorConsumer);
  if (await Bun.file(join(monitorConsumer, 'node_modules/stitchkit/package.json')).exists())
    throw new Error('a monitor consumer received stitchkit it did not ask for');
  for (const name of Object.keys(rendererPeers)) {
    for (const directory of [consumer, monitorConsumer]) {
      if (
        await Bun.file(
          join(directory, `node_modules/stitchkit-tui/node_modules/${name}/package.json`),
        ).exists()
      )
        throw new Error(`the install holds a second ${name} under stitchkit-tui`);
    }
  }
  const manifestText = await run(
    ['tar', '-xOf', tuiArchive, 'package/package.json'],
    consumer,
  );
  if (manifestText.includes('workspace:'))
    throw new Error('packed TUI manifest retains workspace protocol');
  // The framework is a peer: the install has one copy of it, the project's own,
  // with no override forcing it. A dependency would freeze a range at pack time
  // and give every project a second, older stitchkit once the framework moves on.
  const packed: unknown = JSON.parse(manifestText);
  const field = (name: string): unknown =>
    typeof packed === 'object' && packed !== null ? Reflect.get(packed, name) : undefined;
  const declares = (name: string) => {
    const dependencies = field(name);
    return (
      typeof dependencies === 'object' && dependencies !== null && 'stitchkit' in dependencies
    );
  };
  if (declares('dependencies') || !declares('peerDependencies'))
    throw new Error('packed TUI manifest must declare stitchkit as a peer, not a dependency');
  if (
    await Bun.file(
      join(consumer, 'node_modules/stitchkit-tui/node_modules/stitchkit/package.json'),
    ).exists()
  )
    throw new Error('the install holds a second stitchkit under stitchkit-tui');
  const contents = await run(['tar', '-tzf', tuiArchive], consumer);
  if (!contents.includes('package/dist/cli.js'))
    throw new Error('packed TUI archive omits its CLI');
  if (!contents.includes('package/dist/core/index.js'))
    throw new Error('packed TUI archive omits its core entrypoint');
  if (!contents.includes('package/dist/widgets/index.js'))
    throw new Error('packed TUI archive omits its widgets entrypoint');
  for (const entry of ['build', 'testing'])
    if (!contents.includes(`package/dist/${entry}/index.js`))
      throw new Error(`packed TUI archive omits its ${entry} entrypoint`);
  if (!contents.includes('package/dist/gallery/main.js'))
    throw new Error('packed TUI archive omits its gallery binary');
  // The gallery runs from the archive in a real terminal and draws its catalogue.
  const gallery = await run(
    [
      'bash',
      '-lc',
      `(sleep 2; printf '\\003') | timeout 15s script -qec 'stty cols 100 rows 30; bun node_modules/.bin/stitchkit-tui-gallery' /dev/null`,
    ],
    monitorConsumer,
  );
  // Colour changes split a word on screen; the text a reader sees is what is left without them.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing the terminal's colour sequences
  const shown = gallery.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  if (!shown.includes('Catalogue') || !shown.includes('Documents'))
    throw new Error(`packed gallery did not draw its catalogue:\n${gallery.slice(-400)}`);
  const widgetsProbe = await run(['bun', 'probe.tsx'], monitorConsumer);
  if (!widgetsProbe.includes('packed TUI widgets consumer: ok'))
    throw new Error('packed widgets probe was silent');
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
