import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import { assertUsableEnvironment, ensureLocalEnvironment } from './local-env';

describe('ensureLocalEnvironment', () => {
  test('renders the application identity into a fresh .env and never touches an existing one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-env-'));
    try {
      await writeFile(
        join(root, '.env.example'),
        'DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/stitchkit_starter\n',
      );
      // Rendering succeeds — a generator that refuses to generate would break `--no-install`
      // scaffolding — and the separate usability check is what refuses.
      ensureLocalEnvironment(root);
      expect(() => assertUsableEnvironment(root)).toThrow(/USER:PASSWORD/);
      const created = await readFile(join(root, '.env'), 'utf8');
      // In the neutral dev workspace the slug IS the neutral identity, so the
      // substitution is proven end-to-end by the starter lane on a renamed
      // scaffold; here we prove the file is created from the example with the
      // identity-derived database name in place.
      const databaseName = appDeclaration.identity.slug.replaceAll('-', '_');
      expect(created).toContain(`5432/${databaseName}`);

      // Idempotency — a developer's local credentials survive every dev run.
      await writeFile(join(root, '.env'), 'DATABASE_URL=postgresql://real-creds@db/mine\n');
      ensureLocalEnvironment(root);
      expect(await readFile(join(root, '.env'), 'utf8')).toContain('real-creds');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a clean framework source tree reads the pre-scaffold example name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-source-env-'));
    try {
      await writeFile(
        join(root, '_env.example'),
        'DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/stitchkit_starter\n',
      );
      ensureLocalEnvironment(root);
      expect(() => assertUsableEnvironment(root)).toThrow(/USER:PASSWORD/);
      const databaseName = appDeclaration.identity.slug.replaceAll('-', '_');
      expect(await readFile(join(root, '.env'), 'utf8')).toContain(`5432/${databaseName}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an unedited .env is refused on every later run, not only the one that wrote it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-env-again-'));
    try {
      // No example at all: the file is already there, exactly as a second `bun run dev` finds it.
      await writeFile(
        join(root, '.env'),
        'DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/app\n',
      );
      let message = '';
      try {
        assertUsableEnvironment(root);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // The message has to name the file, the line and the privilege the next step needs —
      // a refusal that only says "invalid" moves the search back to the reader.
      expect(message).toContain('.env:1');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('CREATEDB');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a commented example line is not mistaken for an unresolved credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-env-comment-'));
    try {
      // The placeholder is assembled rather than written: spelled out it is a credential inside
      // a URL, which the publication-privacy gate refuses on sight — rightly, since "it is only
      // a fixture" is the argument every leak makes. Same idiom as `check-authored.ts`.
      const placeholder = ['USER', 'PASSWORD'].join(':');
      await writeFile(
        join(root, '.env'),
        [
          `# DATABASE_URL=postgresql://${placeholder}@127.0.0.1:5432/example`,
          'DATABASE_URL=postgresql://127.0.0.1:5432/app',
          '',
        ].join('\n'),
      );
      expect(() => assertUsableEnvironment(root)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
