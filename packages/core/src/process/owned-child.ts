import { spawn } from 'node:child_process';

const groups = new WeakSet<object>();

/** Only this native spawn can establish group ownership; structural PIDs cannot. */
export function spawnOwnedCommand(input: {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  group: boolean;
}) {
  const child = spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached: input.group,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (input.group) groups.add(child);
  return child;
}

export function ownsCommandGroup(child: object): boolean {
  return groups.has(child);
}
