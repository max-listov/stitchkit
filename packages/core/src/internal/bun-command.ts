/**
 * The one place of this leaf that names the Bun global: a bounded command started through
 * `Bun.spawn` when the host is Bun, and nothing when it is not.
 */

/** A command that was started: its stdout once it has ended well, and a way to end it. */
export interface LaunchedCommand {
  readonly stdout: Promise<string>;
  stop(): void;
}

/** Starts a command. The tests replace it with a child whose end is never reported. */
export type CommandLauncher = (
  file: string,
  args: readonly string[],
  maxBuffer: number,
) => LaunchedCommand;

/**
 * Under Bun the command goes through `Bun.spawn`: Bun's `node:child_process` can lose a child's
 * end under host load inside `bun test`, and `execFile` then calls back neither with the output
 * nor with its own timeout. `Bun.spawn` observes the same end reliably.
 */
const spawnWithBun: CommandLauncher = (file, args, maxBuffer) => {
  const child = Bun.spawn([file, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const read = async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;
      if (bytes > maxBuffer) {
        child.kill('SIGKILL');
        throw new Error(`${file} wrote more than ${maxBuffer} bytes`);
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${file} ended with ${exitCode}`);
    return text;
  };
  return { stdout: read(), stop: () => child.kill('SIGKILL') };
};

/** The Bun launcher, or `undefined` off Bun, where `node:child_process` reports a child's end. */
export const launchWithBun: CommandLauncher | undefined =
  typeof Bun === 'undefined' ? undefined : spawnWithBun;
