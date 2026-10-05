import { join } from 'node:path';
import { runNativeCommand } from '../packages/core/src/process/command';

const ROOT = join(import.meta.dir, '..');
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Reads answer in milliseconds; a remote fetch or push gets the network budget. */
const GIT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 180_000;
/** A gate is a whole local verification, which is allowed to take minutes. */
const GATE_TIMEOUT_MS = 45 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function network(command: readonly string[]): boolean {
  return command[0] === 'git' && ['fetch', 'push', 'ls-remote'].includes(command[1] ?? '');
}

/** Run a command in the repository root, streaming its output; refuse a failure or a timeout. */
export async function run(
  command: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error('empty command');
  const result = await runNativeCommand({
    executable,
    args,
    cwd: options.cwd ?? ROOT,
    envPolicy: 'ambient',
    timeoutMs: options.timeoutMs ?? (network(command) ? NETWORK_TIMEOUT_MS : GATE_TIMEOUT_MS),
    onOutput: (bytes, channel) => {
      (channel === 'stdout' ? process.stdout : process.stderr).write(bytes);
    },
  });
  if (result.exitCode !== 0)
    throw new Error(`${command.join(' ')} exited with ${result.exitCode}`);
}

/** Run a command in the repository root and return its trimmed standard output. */
export async function output(
  command: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error('empty command');
  const result = await runNativeCommand({
    executable,
    args,
    cwd: options.cwd ?? ROOT,
    envPolicy: 'ambient',
    timeoutMs: options.timeoutMs ?? (network(command) ? NETWORK_TIMEOUT_MS : GIT_TIMEOUT_MS),
    capture: true,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} exited with ${result.exitCode}: ${decode(result.stderr).trim()}`,
    );
  }
  return decode(result.stdout).trim();
}
