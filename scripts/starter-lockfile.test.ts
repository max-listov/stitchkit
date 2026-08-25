import { describe, expect, test } from 'bun:test';
import {
  assertLockfileResolvesNewest,
  assertRangeIsARange,
  lockedStitchkitVersion,
  newestSatisfying,
  publishedVersions,
} from './starter-lockfile';

const LOCK = `{
  "lockfileVersion": 1,
  "catalog": {
    "stitchkit": "^0.60.1",
  },
  "packages": {
    "socket.io-client": ["socket.io-client@4.8.3", "", {}, "sha512-x"],
    "stitchkit": ["stitchkit@0.60.1", "", { "dependencies": { "ky": "^2.0.2" } }, "sha512-y"],
  }
}
`;

describe('a starter release is two halves', () => {
  test('the lockfile pin is read from the resolution, not from a range', () => {
    expect(lockedStitchkitVersion(LOCK)).toBe('0.60.1');
  });

  test('a lockfile with no stitchkit entry is refused by name', () => {
    expect(() => lockedStitchkitVersion('{"packages":{}}')).toThrow(/no resolved `stitchkit`/);
  });

  test('the newest satisfying version ignores prereleases', () => {
    expect(newestSatisfying('^0.60.0', ['0.60.0', '0.60.1', '0.60.2-rc.1', '0.61.0'])).toBe(
      '0.60.1',
    );
  });

  test('a range that deliberately targets an older minor is satisfied at that minor', () => {
    // Not every starter release chases the newest framework. What is checked is
    // the lockfile against the range it ships with, never against npm's head.
    expect(() =>
      assertLockfileResolvesNewest('0.59.4', '^0.59.0', ['0.59.4', '0.60.0', '0.60.1']),
    ).not.toThrow();
  });

  test('the exact 0.4.1 failure is refused', () => {
    // Shipped range `^0.60.0`, shipped lockfile 0.60.0, npm already serving
    // 0.60.1. Every manifest read as correct; only an install revealed it.
    expect(() =>
      assertLockfileResolvesNewest('0.60.0', '^0.60.0', ['0.60.0', '0.60.1']),
    ).toThrow(/would install 0\.60\.0/);
  });

  test('a lockfile outside its own range is refused with a different reason', () => {
    expect(() => assertLockfileResolvesNewest('0.59.0', '^0.60.0', ['0.60.0'])).toThrow(
      /does not even allow/,
    );
  });

  test('a range nothing on npm satisfies is refused', () => {
    expect(() => assertLockfileResolvesNewest('0.99.0', '^0.99.0', ['0.60.1'])).toThrow(
      /publishes nothing that satisfies/,
    );
  });

  test('a range that is not a range is named as such', () => {
    // `Bun.semver.satisfies` answers true for anything it cannot parse, so
    // `catalog:` and `latest` "match" every published version — and the gate
    // would refuse with a message about a stale lockfile for what is really a
    // typo, sending the reader after the wrong thing.
    for (const notARange of ['catalog:', 'latest', 'workspace:*', '']) {
      expect(() => assertRangeIsARange(notARange)).toThrow(/not a version range/);
    }
    for (const range of ['^0.60.1', '~0.60.1', '0.60.1', '*', '>=0.60.0', '>= 0.60.0']) {
      expect(() => assertRangeIsARange(range)).not.toThrow();
    }
  });

  test('the refusal for an unsatisfiable range names the next step too', () => {
    // Two of the three refusals said what to run; this one did not, and the
    // record claimed all of them did.
    expect(() => assertLockfileResolvesNewest('0.99.0', '^0.99.0', ['0.60.1'])).toThrow(
      /update:starter/,
    );
  });

  test('an unreachable registry is a refusal, never a pass', async () => {
    // The failure mode this gate would otherwise have: it cannot ask, so it
    // says yes. A check that reports green when it could not run is worse than
    // no check — and it fails open precisely on the release where the network
    // was flaky.
    const offline = (): Promise<Response> =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    await expect(publishedVersions('stitchkit', offline)).rejects.toThrow(
      /refuses rather than passing/,
    );
  });

  test('a registry error status is a refusal too', async () => {
    const failing = (): Promise<Response> =>
      Promise.resolve(new Response('', { status: 503 }));
    await expect(publishedVersions('stitchkit', failing)).rejects.toThrow(/answered 503/);
  });

  test('a well-formed answer becomes a version list', async () => {
    const serving = (): Promise<Response> =>
      Promise.resolve(Response.json({ versions: { '0.60.0': {}, '0.60.1': {} } }));
    expect(await publishedVersions('stitchkit', serving)).toEqual(['0.60.0', '0.60.1']);
  });
});
