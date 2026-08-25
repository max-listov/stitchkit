import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import {
  assertArtifactMatchesSource,
  BUILD_STAMP_PATH,
  sourceDigest,
  writeBuildStamp,
} from './build-stamp';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'build-stamp-'));
  created.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  return root;
}

describe('a release starts this source, not a previous one', () => {
  test('a stamped tree passes its own check', async () => {
    const root = await tree({ 'src/index.ts': 'export const a = 1;\n' });
    writeBuildStamp(root, []);
    expect(() => assertArtifactMatchesSource(root, [])).not.toThrow();
  });

  test('an edited source file makes the artifact refuse to start', async () => {
    // The failure this exists for: `pm2:prod` without a build applies THIS
    // source's migrations and starts the previous source's `dist`. The schema
    // moves ahead of the code, and rolling the code back does not undo it.
    const root = await tree({ 'src/index.ts': 'export const a = 1;\n' });
    writeBuildStamp(root, []);
    await writeFile(join(root, 'src/index.ts'), 'export const a = 2;\n');
    expect(() => assertArtifactMatchesSource(root, [])).toThrow(/not this source's/);
  });

  test('a new source file counts, without anyone listing it', async () => {
    const root = await tree({ 'src/index.ts': 'export const a = 1;\n' });
    writeBuildStamp(root, []);
    await writeFile(join(root, 'src/added.ts'), 'export const b = 2;\n');
    expect(() => assertArtifactMatchesSource(root, [])).toThrow(/not this source's/);
  });

  test('a moved file changes the digest even with every byte unchanged', async () => {
    const root = await tree({ 'src/index.ts': 'export const a = 1;\n' });
    const before = sourceDigest(root, []);
    await rm(join(root, 'src/index.ts'));
    await writeFile(join(root, 'src/moved.ts'), 'export const a = 1;\n');
    expect(sourceDigest(root, [])).not.toBe(before);
  });

  test('a binding is not an input — editing `.env` does not refuse the artifact', async () => {
    // Deliberate, and the one exclusion that is a JUDGEMENT rather than a fact
    // about outputs. This project forbids build-time environment reads —
    // `check-authored` refuses direct environment access outside its declared
    // boundaries, and the packed lane builds against a database that accepts
    // nothing — so hashing
    // `.env` would refuse a correct artifact every time a deployment edited its
    // own environment.
    const root = await tree({ 'src/index.ts': 'export const a = 1;\n', '.env': 'PORT=1\n' });
    writeBuildStamp(root, []);
    await writeFile(join(root, '.env'), 'PORT=2\n');
    expect(() => assertArtifactMatchesSource(root, [])).not.toThrow();
  });

  test('a Markdown file counts, because a project may import one', async () => {
    // The digest used to skip every `.md`, every test file and every directory
    // called `generated`. All three are true of THIS project today and none is
    // true by construction: MDX is an import, and a checked-in directory may be
    // called anything. A digest that answers "fresh" about a stale build is the
    // failure the stamp exists to prevent.
    const root = await tree({
      'src/index.ts': 'export const a = 1;\n',
      'content/post.md': 'before\n',
    });
    writeBuildStamp(root, []);
    await writeFile(join(root, 'content/post.md'), 'after\n');
    expect(() => assertArtifactMatchesSource(root, [])).toThrow(/not this source's/);
  });

  test('a directory merely NAMED generated is source', async () => {
    const root = await tree({
      'src/index.ts': 'export const a = 1;\n',
      'src/generated/checked-in.ts': 'export const kept = 1;\n',
    });
    writeBuildStamp(root, []);
    await writeFile(join(root, 'src/generated/checked-in.ts'), 'export const kept = 2;\n');
    expect(() => assertArtifactMatchesSource(root, [])).toThrow(/not this source's/);
  });

  test('a test file counts too', async () => {
    const root = await tree({
      'src/index.ts': 'export const a = 1;\n',
      'src/index.test.ts': 'test("x", () => {});\n',
    });
    writeBuildStamp(root, []);
    await writeFile(join(root, 'src/index.test.ts'), 'test("y", () => {});\n');
    expect(() => assertArtifactMatchesSource(root, [])).toThrow(/not this source's/);
  });

  test('what the DECLARATION calls output is skipped, by path and not by name', async () => {
    // The one list a deployment tool already reads. `packages/db/src/generated`
    // is skipped because `build.artifacts` says it is produced, not because of
    // the word in it.
    const artifacts = ['packages/db/src/generated', 'packages/frontend/.next'];
    const root = await tree({
      'src/index.ts': 'export const a = 1;\n',
      'node_modules/pkg/index.js': 'module.exports = 1;\n',
      'packages/db/src/generated/client.ts': 'export const generated = 1;\n',
      'packages/frontend/.next/build-manifest.json': '{}\n',
    });
    writeBuildStamp(root, artifacts);
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'module.exports = 2;\n');
    await writeFile(
      join(root, 'packages/db/src/generated/client.ts'),
      'export const generated = 2;\n',
    );
    await writeFile(join(root, 'packages/frontend/.next/build-manifest.json'), '{"c":1}\n');
    expect(() => assertArtifactMatchesSource(root, artifacts)).not.toThrow();
  });

  test('an undeclared build output is NOT skipped', async () => {
    // Falsification for the test above: without it, a helper that skipped every
    // `.next` anywhere would pass it just as well.
    const root = await tree({
      'src/index.ts': 'export const a = 1;\n',
      'packages/frontend/.next/build-manifest.json': '{}\n',
    });
    writeBuildStamp(root, []);
    await writeFile(join(root, 'packages/frontend/.next/build-manifest.json'), '{"c":1}\n');
    expect(() => assertArtifactMatchesSource(root, [])).toThrow(/not this source's/);
  });

  test('this project declares its outputs, so the default skips them', async () => {
    expect(appDeclaration.build?.artifacts).toContain('packages/db/src/generated');
  });

  test('no stamp at all is refused, not assumed fresh', async () => {
    const root = await tree({ 'src/index.ts': 'export const a = 1;\n' });
    expect(() => assertArtifactMatchesSource(root, [])).toThrow(new RegExp(BUILD_STAMP_PATH));
  });
});
