import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import { ensureLocalEnvironment } from './local-env';

describe('ensureLocalEnvironment', () => {
  test('renders the application identity into a fresh .env and never touches an existing one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-env-'));
    try {
      await writeFile(
        join(root, '.env.example'),
        'DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/stitchkit_starter\n',
      );
      ensureLocalEnvironment(root);
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
});
