import { describe, expect, test } from 'bun:test';
import { appDeclaration } from '../packages/config/src/declaration';
import { assertBuildArtifacts, formatCommand, migrationCommandFor } from './release-steps';

describe('release steps come from the declaration', () => {
  test('the declared engine resolves to this project one command', () => {
    expect(migrationCommandFor()).toEqual(['bun', 'run', 'db:deploy']);
  });

  test('no declared migrations means no migration step, not a skipped one', () => {
    expect(migrationCommandFor({ ...appDeclaration, release: {} })).toBeUndefined();
  });

  test('an engine this project cannot apply is refused, never skipped', () => {
    // Silently not migrating is the failure that leaves a machine running
    // against the wrong schema — it has to be loud.
    const foreign = {
      ...appDeclaration,
      release: {
        migrations: { engine: 'flyway', root: 'packages/db/migrations', lockfile: 'x' },
      },
    };
    expect(() => migrationCommandFor(foreign)).toThrow(/has no command for/);
  });

  test('a declared migration root that does not exist is refused', () => {
    const missing = {
      ...appDeclaration,
      release: {
        migrations: { engine: 'prisma', root: 'packages/db/nowhere', lockfile: 'x' },
      },
    };
    expect(() => migrationCommandFor(missing)).toThrow(/does not exist/);
  });
});

describe('build artifacts are checked before roles start', () => {
  test('a missing artifact is named, together with the command that makes it', () => {
    const unbuilt = {
      ...appDeclaration,
      build: {
        command: { executable: 'bun', args: ['run', 'build'] },
        artifacts: ['packages/backend/nowhere'],
      },
    };
    // The test used to stop at the artifact name, which is why nobody noticed
    // that the second half of the sentence had become `[object Object]` when
    // commands turned into `{ executable, args }`. A diagnostic exists to be
    // retyped, so the assertion reads it the way an operator would.
    expect(() => assertBuildArtifacts(unbuilt)).toThrow(
      /Missing build artifacts: packages\/backend\/nowhere — run `bun run build` first\./,
    );
  });

  test('a command with a space survives the diagnostic intact', () => {
    expect(formatCommand({ executable: 'bun', args: ['run', 'build --out dir name'] })).toBe(
      'bun run "build --out dir name"',
    );
  });

  test('the diagnostic never prints an object', () => {
    const declared = appDeclaration.build;
    if (!declared) throw new Error('the template declares a build');
    expect(formatCommand(declared.command)).not.toContain('[object');
    expect(formatCommand(declared.command)).toBe('bun run build');
  });

  test('the check covers every declared artifact, not a list kept beside it', () => {
    const declared = appDeclaration.build?.artifacts ?? [];
    expect(declared.length).toBeGreaterThan(1);
    for (const artifact of declared) {
      expect(() =>
        assertBuildArtifacts({
          ...appDeclaration,
          build: {
            command: { executable: 'bun', args: ['run', 'build'] },
            artifacts: [`${artifact}-absent`],
          },
        }),
      ).toThrow(new RegExp(`${artifact.replaceAll('/', '\\/')}-absent`));
    }
  });

  test('a project that builds nothing passes', () => {
    expect(() => assertBuildArtifacts({ ...appDeclaration, build: undefined })).not.toThrow();
  });
});
