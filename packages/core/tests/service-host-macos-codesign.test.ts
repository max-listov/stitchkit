import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODESIGN_PATH,
  findDeveloperIds,
  type MacosCommandRunner,
  parseCodesignDetails,
  parseDeveloperIdsOutput,
  resolveSigningIdentity,
  SECURITY_PATH,
  signBundle,
  verifySignedBundle,
} from '../src/entrypoints/service-host/macos';

const VALID_SHA1 = '0123456789ABCDEF0123456789ABCDEF01234567';
const SECOND_SHA1 = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98';
const VALID_DEV_ID = 'Developer ID Application: Example Corp (A1B2C3D4E5)';
const VALID_CDHASH = '0123456789abcdef0123456789abcdef01234567';

const VALID_CODESIGN_STDERR = [
  'Executable=/Users/example-user/Applications/Example.app/Contents/MacOS/example-launcher',
  'Identifier=com.example.daemon',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=512 flags=0x10000(runtime) hashes=10+3 location=embedded',
  `CDHash=${VALID_CDHASH}`,
  'Signature size=9024',
  `Authority=${VALID_DEV_ID}`,
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Nov 23, 2026 at 12:00:00',
  'TeamIdentifier=A1B2C3D4E5',
].join('\n');

describe('service-host/macos codesign identity resolution', () => {
  test('parseDeveloperIdsOutput keeps valid Developer ID Application identities and filters revoked/non-Developer-ID certs', () => {
    const output = [
      `  1) ${VALID_SHA1} "${VALID_DEV_ID}"`,
      `  2) ${SECOND_SHA1} "Developer ID Application: Revoked Corp (ZZZZ999999)" (CSSMERR_TP_CERT_REVOKED)`,
      '  3) 1111111111111111111111111111111111111111 "Apple Development: Dev Person (Q1W2E3R4T5)"',
      `  4) ${VALID_SHA1} "${VALID_DEV_ID}"`,
      '     4 valid identities found',
    ].join('\n');

    expect(parseDeveloperIdsOutput(output)).toEqual([
      { sha1: VALID_SHA1, commonName: VALID_DEV_ID, teamId: 'A1B2C3D4E5' },
    ]);
  });

  test('resolveSigningIdentity is strictly fail-closed on null, empty, whitespace, ad-hoc "-", CSSMERR, non-Developer-ID, 0 certs, and >1 certs', async () => {
    const zeroRunner: MacosCommandRunner = {
      async runCommand() {
        return { exitCode: 0, stdout: '0 valid identities found\n', stderr: '' };
      },
    };
    const twoRunner: MacosCommandRunner = {
      async runCommand() {
        return {
          exitCode: 0,
          stdout: [
            `  1) ${VALID_SHA1} "${VALID_DEV_ID}"`,
            `  2) ${SECOND_SHA1} "Developer ID Application: Second Corp (Z9Y8X7W6V5)"`,
          ].join('\n'),
          stderr: '',
        };
      },
    };
    const oneRunner: MacosCommandRunner = {
      async runCommand() {
        return {
          exitCode: 0,
          stdout: `  1) ${VALID_SHA1} "${VALID_DEV_ID}"\n`,
          stderr: '',
        };
      },
    };

    for (const bad of [
      null,
      '',
      '   ',
      '-',
      'Developer ID Application:',
      'Developer ID Application:   ',
      'Apple Development: Example (A1B2C3D4E5)',
      'Developer ID Application: Revoked (A1B2C3D4E5) (CSSMERR_TP_CERT_REVOKED)',
    ]) {
      await expect(
        resolveSigningIdentity({ identity: bad, runner: oneRunner }),
      ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    }

    await expect(resolveSigningIdentity({ runner: zeroRunner })).rejects.toMatchObject({
      code: 'NO_DEVELOPER_ID',
    });
    await expect(resolveSigningIdentity({ runner: twoRunner })).rejects.toMatchObject({
      code: 'AMBIGUOUS_IDENTITY',
    });

    expect(await resolveSigningIdentity({ runner: oneRunner })).toBe(VALID_DEV_ID);
    expect(await resolveSigningIdentity({ identity: VALID_DEV_ID, runner: zeroRunner })).toBe(
      VALID_DEV_ID,
    );
    expect(
      await resolveSigningIdentity({ identity: VALID_SHA1.toLowerCase(), runner: oneRunner }),
    ).toBe(VALID_SHA1);
    await expect(
      resolveSigningIdentity({ identity: SECOND_SHA1, runner: oneRunner }),
    ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
  });

  test('findDeveloperIds passes optional keychain argument to /usr/bin/security', async () => {
    const calls: Array<{ exe: string; args: readonly string[] }> = [];
    const runner: MacosCommandRunner = {
      async runCommand(exe, args) {
        calls.push({ exe, args });
        return { exitCode: 0, stdout: `  1) ${VALID_SHA1} "${VALID_DEV_ID}"\n`, stderr: '' };
      },
    };
    const ids = await findDeveloperIds({
      keychain: '/Users/example-user/Library/Keychains/login.keychain-db',
      runner,
    });
    expect(ids).toHaveLength(1);
    expect(calls[0]).toEqual({
      exe: SECURITY_PATH,
      args: [
        'find-identity',
        '-v',
        '-p',
        'codesigning',
        '/Users/example-user/Library/Keychains/login.keychain-db',
      ],
    });
    await expect(findDeveloperIds({ keychain: '-v', runner })).rejects.toMatchObject({
      code: 'INVALID_IDENTITY',
    });
  });
});

describe('service-host/macos codesign verification and signing', () => {
  test('a forged chain with Apple names is refused; codesign evaluates the anchor, not the names', async () => {
    // Captured on macOS 27.2.1: a three-level chain whose root is a self-signed
    // `CN=Apple Root CA`, signed with rcodesign. Its `Authority=` lines and its
    // designated requirement pass; Apple's anchor does not (codesign exits 3).
    const fixture = (name: string) =>
      readFileSync(
        join(import.meta.dir, 'fixtures/macos', `codesign-dvvv.${name}.txt`),
        'utf8',
      );
    const requirements: string[] = [];
    const runnerFor = (dvvv: string, anchoredInApple: boolean): MacosCommandRunner => ({
      async runCommand(_exe, args) {
        if (args[0] !== '--verify') return { exitCode: 0, stdout: '', stderr: dvvv };
        const requirement = args.find((arg) => arg.startsWith('-R='));
        if (requirement) requirements.push(requirement);
        return requirement && !anchoredInApple
          ? {
              exitCode: 3,
              stdout: '',
              stderr: 'test-requirement: code failed to satisfy specified code requirement(s)',
            }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/fixture-user/Applications/FixtureEnsure.app',
        expectedBundleId: 'com.stitchkit.fixture.ensure',
        expectedTeamId: 'ABCDE12345',
        runner: runnerFor(fixture('forged-apple-named-chain'), false),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    expect(requirements.at(-1)).toBe(
      '-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"',
    );

    const chrome = await verifySignedBundle({
      bundlePath: '/Applications/Google Chrome.app',
      expectedBundleId: 'com.google.Chrome',
      runner: runnerFor(fixture('real-developer-id.google-chrome'), true),
    });
    expect(chrome.teamIdentifier).toBe('EQHXZ8M8AV');
    expect(requirements.at(-1)).toEndWith('leaf[subject.OU] = "EQHXZ8M8AV"');
  });

  test('parseCodesignDetails parses stderr metadata including hardened runtime and Authority chain', () => {
    const details = parseCodesignDetails(VALID_CODESIGN_STDERR);
    expect(details).toEqual({
      identifier: 'com.example.daemon',
      teamIdentifier: 'A1B2C3D4E5',
      cdHash: VALID_CDHASH,
      signature: null,
      flags: '0x10000(runtime)',
      hasHardenedRuntime: true,
      authorities: [VALID_DEV_ID, 'Developer ID Certification Authority', 'Apple Root CA'],
    });
  });

  test('verifySignedBundle accepts full Developer ID chain and refuses ad-hoc, missing team, broken chain, wrong identifier, or missing runtime', async () => {
    const makeRunner = (dvvvStderr: string, verifyExit = 0): MacosCommandRunner => ({
      async runCommand(exe, args) {
        expect(exe).toBe(CODESIGN_PATH);
        if (args[0] === '--verify') {
          return {
            exitCode: verifyExit,
            stdout: '',
            stderr: verifyExit === 0 ? '' : 'invalid seal',
          };
        }
        return { exitCode: 0, stdout: '', stderr: dvvvStderr };
      },
    });

    const verified = await verifySignedBundle({
      bundlePath: '/Users/example-user/Applications/Example.app',
      expectedBundleId: 'com.example.daemon',
      expectedTeamId: 'A1B2C3D4E5',
      runner: makeRunner(VALID_CODESIGN_STDERR),
    });
    expect(verified.cdHash).toBe(VALID_CDHASH);
    expect(verified.teamIdentifier).toBe('A1B2C3D4E5');
    expect(verified.hasHardenedRuntime).toBe(true);

    const adhocStderr = VALID_CODESIGN_STDERR.replace(
      'Signature size=9024',
      'Signature=adhoc',
    );
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        expectedBundleId: 'com.example.daemon',
        runner: makeRunner(adhocStderr),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });

    const teamNotSet = VALID_CODESIGN_STDERR.replace(
      'TeamIdentifier=A1B2C3D4E5',
      'TeamIdentifier=not set',
    );
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        expectedBundleId: 'com.example.daemon',
        runner: makeRunner(teamNotSet),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });

    const brokenChain = VALID_CODESIGN_STDERR.replace(
      'Authority=Apple Root CA',
      'Authority=Untrusted Root CA',
    );
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        expectedBundleId: 'com.example.daemon',
        runner: makeRunner(brokenChain),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });

    const noRuntime = VALID_CODESIGN_STDERR.replace(
      'flags=0x10000(runtime)',
      'flags=0x0(none)',
    );
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        expectedBundleId: 'com.example.daemon',
        runner: makeRunner(noRuntime),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });

    const relaxed = await verifySignedBundle({
      bundlePath: '/Users/example-user/Applications/Example.app',
      expectedBundleId: 'com.example.daemon',
      requireHardenedRuntime: false,
      runner: makeRunner(noRuntime),
    });
    expect(relaxed.hasHardenedRuntime).toBe(false);

    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        expectedBundleId: 'com.example.other',
        runner: makeRunner(VALID_CODESIGN_STDERR),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });

    // Reject extra 4th authority, bare leaf prefix, and CR/LF path injection
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        expectedBundleId: 'com.example.daemon',
        runner: makeRunner(`${VALID_CODESIGN_STDERR}\nAuthority=Extra Untrusted CA`),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        expectedBundleId: 'com.example.daemon',
        runner: makeRunner(
          VALID_CODESIGN_STDERR.replace(
            `Authority=${VALID_DEV_ID}`,
            'Authority=Developer ID Application:   ',
          ),
        ),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    await expect(
      verifySignedBundle({
        bundlePath: '/Users/example-user/Applications/Bad\nPath.app',
        expectedBundleId: 'com.example.daemon',
        runner: makeRunner(VALID_CODESIGN_STDERR),
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    await expect(
      findDeveloperIds({
        keychain: '/Users/example-user/bad\rkeychain',
        runner: makeRunner(''),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
  });

  test('signBundle refuses ad-hoc "-" and CR/LF paths, and passes hardened runtime + timestamp by default', async () => {
    const calls: Array<{ exe: string; args: readonly string[] }> = [];
    const runner: MacosCommandRunner = {
      async runCommand(exe, args) {
        calls.push({ exe, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    await expect(
      signBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        identity: '-',
        runner,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    await expect(
      signBundle({
        bundlePath: '/Users/example-user/Applications/Example\nEvil.app',
        identity: VALID_DEV_ID,
        runner,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    await expect(
      signBundle({
        bundlePath: '/Users/example-user/Applications/Example.app',
        identity: VALID_DEV_ID,
        entitlementsPath: '/Users/example-user/bad\rentitlements.plist',
        runner,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(calls).toHaveLength(0);

    await signBundle({
      bundlePath: '/Users/example-user/Applications/Example.app',
      identity: VALID_DEV_ID,
      entitlementsPath: '/Users/example-user/entitlements.plist',
      runner,
    });
    expect(calls[0]).toEqual({
      exe: CODESIGN_PATH,
      args: [
        '--force',
        '--sign',
        VALID_DEV_ID,
        '--options',
        'runtime',
        '--timestamp',
        '--entitlements',
        '/Users/example-user/entitlements.plist',
        '/Users/example-user/Applications/Example.app',
      ],
    });
  });

  test('signBundle toggles --deep, --options runtime, and --timestamp according to deep, hardenedRuntime, and timestamp options', async () => {
    const calls: Array<{ exe: string; args: readonly string[] }> = [];
    const runner: MacosCommandRunner = {
      async runCommand(exe, args) {
        calls.push({ exe, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const bundlePath = '/Users/example-user/Applications/Example.app';

    // Default call: hardenedRuntime=true, timestamp=true, deep=false
    await signBundle({
      bundlePath,
      identity: VALID_DEV_ID,
      runner,
    });
    expect(calls[0]?.args).toEqual([
      '--force',
      '--sign',
      VALID_DEV_ID,
      '--options',
      'runtime',
      '--timestamp',
      bundlePath,
    ]);
    expect(calls[0]?.args).not.toContain('--deep');

    // All three toggled: deep=true, hardenedRuntime=false, timestamp=false
    await signBundle({
      bundlePath,
      identity: VALID_DEV_ID,
      deep: true,
      hardenedRuntime: false,
      timestamp: false,
      runner,
    });
    expect(calls[1]?.args).toEqual(['--force', '--sign', VALID_DEV_ID, '--deep', bundlePath]);
    expect(calls[1]?.args).toContain('--deep');
    expect(calls[1]?.args).not.toContain('--options');
    expect(calls[1]?.args).not.toContain('runtime');
    expect(calls[1]?.args).not.toContain('--timestamp');

    // Individual controls proving each flag is independently load-bearing
    await signBundle({
      bundlePath,
      identity: VALID_DEV_ID,
      hardenedRuntime: false,
      runner,
    });
    expect(calls[2]?.args).toEqual([
      '--force',
      '--sign',
      VALID_DEV_ID,
      '--timestamp',
      bundlePath,
    ]);

    await signBundle({
      bundlePath,
      identity: VALID_DEV_ID,
      timestamp: false,
      runner,
    });
    expect(calls[3]?.args).toEqual([
      '--force',
      '--sign',
      VALID_DEV_ID,
      '--options',
      'runtime',
      bundlePath,
    ]);

    await signBundle({
      bundlePath,
      identity: VALID_DEV_ID,
      deep: true,
      runner,
    });
    expect(calls[4]?.args).toEqual([
      '--force',
      '--sign',
      VALID_DEV_ID,
      '--options',
      'runtime',
      '--timestamp',
      '--deep',
      bundlePath,
    ]);
  });
});
