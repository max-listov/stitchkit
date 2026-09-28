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
 * Google Fonts also answers about one request in sixty with font URLs of the
 * form `/l/font?kit=…&skey=…`, which Next cannot parse (vercel/next.js#99114):
 * Turbopack fails with `next/font/google queries have exactly one entry`,
 * webpack with a `TypeError` inside `next/font`. Nothing is wrong in the tree
 * then either, and the next request is almost always the usual shape.
 *
 * A build that failed for one of those reasons is run once more — after the
 * build cache that holds Google's answer is removed, or the retry reads the
 * same answer back — and the lane says so. Any other failure fails the lane as
 * before, and a second font failure too: an outage that outlasts one retry is
 * a real answer.
 */
import { rm } from 'node:fs/promises';

/** What Next prints when the Google Fonts answer, not the code, failed the build. */
const GOOGLE_FONTS_UNREACHABLE = [
  /Failed to fetch font `[^`]+`/,
  /Failed to fetch `[^`]+` from Google Fonts/,
  /internal\/font\/google\/[\w.-]+/,
  /next\/font\/google queries have exactly one entry/,
  /An error occurred in `next\/font`/,
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
  options: {
    readonly log?: (line: string) => void;
    readonly pauseMs?: number;
    /** Build caches to remove before the second attempt — they hold Google's first answer. */
    readonly caches?: readonly string[];
  } = {},
): Promise<StarterBuildResult> {
  const first = await attempt();
  if (first.exitCode === 0 || !failedOnGoogleFonts(first.output)) return first;
  (options.log ?? console.log)(
    '[starter build] Google Fonts failed the build — clearing the build cache and building once more',
  );
  for (const cache of options.caches ?? []) await rm(cache, { recursive: true, force: true });
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
