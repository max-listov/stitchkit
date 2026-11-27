/**
 * A host that opens a Claude SDK session whose engine the driver spawns itself (`onProviderPid`
 * set, no custom spawner). The engine writes its PID to `<root>/engine.pid`, traps SIGTERM for
 * `<delayMs>`, and otherwise runs until stopped. The host writes `<root>/host-ready` once the
 * turn started, then waits to be killed.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';

const [root = '.', delayMs = '0'] = process.argv.slice(2);
const engine = `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'engine.pid'))}, String(process.pid)); process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${Number(delayMs)})); setInterval(() => {
  // Stay alive until killed: the test kills this host with SIGKILL.
}, 1000);`;
const driver = createClaudeSdkDriver({
  sdkVersion: '0.3.332',
  ambient: { PATH: process.env.PATH, HOME: root },
  onProviderPid: (pid) => writeFileSync(join(root, 'leader.pid'), String(pid)),
  query: ({ prompt, options }) => {
    const child = options?.spawnClaudeCodeProcess?.({
      command: process.execPath,
      args: ['-e', engine],
      cwd: root,
      env: options.env ?? {},
      signal: new AbortController().signal,
    });
    // biome-ignore lint/correctness/useYield: the turn stays open, yielding nothing, until the session ends.
    async function* run(): AsyncGenerator<unknown> {
      for await (const _message of prompt) {
        // Hold the turn open: the engine runs until the session closes or the host dies.
      }
    }
    const records = run();
    return {
      [Symbol.asyncIterator]: () => records,
      interrupt: async () => undefined,
      // As the SDK does on close: ask the engine to stop.
      close: () => child?.kill('SIGTERM'),
    };
  },
});
const session = await driver.open({
  profile: { profileId: 'p', engine: 'claude-sdk', home: join(root, 'home') },
  cwd: root,
});
await session.startTurn({
  turnId: 't',
  clientId: crypto.randomUUID(),
  input: [{ type: 'text', text: 'hi' }],
});
// The engine starts behind its owner-loss guard; wait until it runs before reporting ready.
while (!existsSync(join(root, 'engine.pid')))
  await new Promise((resolve) => setTimeout(resolve, 10));
writeFileSync(join(root, 'host-ready'), '1');
if (process.argv.includes('--close')) {
  await session.close();
  writeFileSync(join(root, 'closed'), '1');
  process.exit(0);
}
setInterval(() => {
  // Stay alive until killed: the test kills this host with SIGKILL.
}, 1000);
