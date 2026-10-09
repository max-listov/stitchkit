import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNativeCommand } from '../../src/entrypoints/process';

const [mode, phase, root, target] = process.argv.slice(2);
if (!mode || !phase || !root || !target)
  throw new Error('owner fixture arguments are required');
if (mode !== 'guarded' && mode !== 'unguarded') throw new Error(`Unknown owner mode ${mode}`);

await runNativeCommand({
  executable: process.execPath,
  args: [target, phase, root],
  timeoutMs: 30_000,
  ...(mode === 'guarded' && { ownerLoss: 'terminate' as const }),
  onLeaderStarted: ({ pid }) => writeFileSync(join(root, 'leader.pid'), String(pid)),
});
