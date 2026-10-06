// Runs one command with the given stdio and group, for a parent that controls this process's
// own stdio (a pseudo-terminal or a file): argv is `<stdio> <group> <shell script>`.
import { runNativeCommand } from '../../src/entrypoints/process';

const [stdio, group, script] = Bun.argv.slice(2);
if (
  (stdio !== 'pipe' && stdio !== 'inherit') ||
  (group !== 'own' && group !== 'caller') ||
  !script
)
  throw new Error('usage: native-inherit-probe <pipe|inherit> <own|caller> <script>');
const result = await runNativeCommand({
  executable: '/bin/sh',
  args: ['-c', script],
  timeoutMs: 10_000,
  stdio,
  group,
  ...(stdio === 'pipe' ? { capture: true, maxOutputBytes: 4096 } : {}),
});
if (stdio === 'pipe') process.stdout.write(result.stdout);
process.exitCode = result.exitCode ?? 1;
