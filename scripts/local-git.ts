const GIT_TIMEOUT_MS = 60_000;

/** One bounded `git` call in `root`; a non-zero exit throws with git's own reason. */
export async function git(
  root: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd: root,
    env: options.env ? { ...Bun.env, ...options.env } : Bun.env,
    stdin: options.input === undefined ? 'ignore' : new TextEncoder().encode(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const [text, reason, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited with ${code}: ${reason.trim()}`);
  return text;
}
