/**
 * Build a generated starter, the way every project of ours builds one.
 *
 * The starter loads its fonts with `next/font/google`, like every Next project
 * of ours: Next downloads them at build time and serves them optimised from the
 * application's own origin. So a build is also a request to Google Fonts, and
 * when Google does not answer, the build fails with nothing wrong in the tree —
 * it did, twice on 2026-09-24, once in a local release gate and once on CI, and
 * each cost a rerun of the whole gate.
 *
 * A build that failed for exactly that reason is run once more, and the lane
 * says so. Any other failure fails the lane as before, and a second font
 * failure too: an outage that outlasts one retry is a real answer.
 */

/** What Next prints when the Google Fonts download, not the code, failed. */
const GOOGLE_FONTS_UNREACHABLE = [
  /Failed to fetch font `[^`]+`/,
  /Failed to fetch `[^`]+` from Google Fonts/,
  /internal\/font\/google\/[\w.-]+/,
];

export function failedOnGoogleFonts(output: string): boolean {
  return GOOGLE_FONTS_UNREACHABLE.some((pattern) => pattern.test(output));
}

export interface StarterBuildResult {
  readonly exitCode: number;
  readonly output: string;
}

/** One build attempt: how it is run is the caller's, the output is what is read. */
export type StarterBuildAttempt = () => Promise<StarterBuildResult>;

export async function buildStarter(
  attempt: StarterBuildAttempt,
  options: { readonly log?: (line: string) => void; readonly pauseMs?: number } = {},
): Promise<StarterBuildResult> {
  const first = await attempt();
  if (first.exitCode === 0 || !failedOnGoogleFonts(first.output)) return first;
  (options.log ?? console.log)(
    '[starter build] Google Fonts did not answer during the build — building once more',
  );
  await Bun.sleep(options.pauseMs ?? 5_000);
  return attempt();
}

/** Run a command, streaming its output as usual and keeping it to read afterwards. */
export async function spawnTee(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined> | undefined,
): Promise<StarterBuildResult> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const chunks: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.write(chunk);
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
  };
  await Promise.all([pump(child.stdout, process.stdout), pump(child.stderr, process.stderr)]);
  return { exitCode: await child.exited, output: chunks.join('') };
}
