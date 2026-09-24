import { describe, expect, test } from 'bun:test';
import { buildStarter, failedOnGoogleFonts, type StarterBuildResult } from './starter-build';

/*
 * One more build, for one reason only: Google Fonts did not answer. The
 * negative controls matter more than the retry — a broken tree must fail on
 * the first attempt exactly as before.
 */

const fontFailure = [
  "@app/frontend build: Error: Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'",
  '@app/frontend build:     at <unknown> ([next]/internal/font/google/montserrat_e478f599.module.css:106:8)',
].join('\n');

function attempts(...results: StarterBuildResult[]) {
  const calls: number[] = [];
  return {
    calls,
    attempt: async () => {
      calls.push(calls.length + 1);
      const next = results[calls.length - 1];
      if (!next) throw new Error('more attempts than expected');
      return next;
    },
  };
}

describe('starter build', () => {
  test('recognises the font download failures Next prints, and nothing else', () => {
    expect(failedOnGoogleFonts(fontFailure)).toBe(true);
    expect(
      failedOnGoogleFonts(
        'Failed to fetch font `Montserrat`.\nURL: https://fonts.googleapis.com/…',
      ),
    ).toBe(true);
    expect(failedOnGoogleFonts("Type error: Property 'x' does not exist on type 'Y'.")).toBe(
      false,
    );
    expect(failedOnGoogleFonts("Module not found: Can't resolve '@app/shared'")).toBe(false);
  });

  test('a font download failure is built once more, and the lane says so', async () => {
    const logs: string[] = [];
    const { calls, attempt } = attempts(
      { exitCode: 1, output: fontFailure },
      { exitCode: 0, output: 'ok' },
    );
    const result = await buildStarter(attempt, {
      log: (line) => void logs.push(line),
      pauseMs: 0,
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([1, 2]);
    expect(logs).toEqual([expect.stringContaining('Google Fonts did not answer')]);
  });

  test('any other failure fails at once; a second font failure is the answer', async () => {
    const broken = attempts({ exitCode: 1, output: 'Type error: nope' });
    expect(
      (await buildStarter(broken.attempt, { log: () => undefined, pauseMs: 0 })).exitCode,
    ).toBe(1);
    expect(broken.calls).toEqual([1]);

    const outage = attempts(
      { exitCode: 1, output: fontFailure },
      { exitCode: 1, output: fontFailure },
    );
    expect(
      (await buildStarter(outage.attempt, { log: () => undefined, pauseMs: 0 })).exitCode,
    ).toBe(1);
    expect(outage.calls).toEqual([1, 2]);
  });

  test('a green build is built once', async () => {
    const green = attempts({ exitCode: 0, output: 'ok' });
    await buildStarter(green.attempt, { pauseMs: 0 });
    expect(green.calls).toEqual([1]);
  });
});
