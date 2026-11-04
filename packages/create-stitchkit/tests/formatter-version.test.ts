import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The generator formats a project with its own Biome, and the project then
 * checks itself with the Biome it installs. Two versions can format the same
 * text differently, so every template locks, declares and describes the
 * version the generator resolves.
 */
const generator = resolve(import.meta.dir, '..');
const repository = resolve(generator, '../..');
const templates = ['template', 'templates/agent', 'templates/telegram-bot'];

function lockedBiome(lockfile: string): string | undefined {
  return /"@biomejs\/biome": \["@biomejs\/biome@([^"]+)"/.exec(
    readFileSync(lockfile, 'utf8'),
  )?.[1];
}

const formatterVersion = lockedBiome(join(repository, 'bun.lock'));

test('the generator resolves one Biome version', () => {
  expect(formatterVersion).toMatch(/^\d+\.\d+\.\d+$/);
  const manifest = JSON.parse(readFileSync(join(generator, 'package.json'), 'utf8'));
  expect(manifest.dependencies['@biomejs/biome']).toBe(formatterVersion);
});

for (const template of templates) {
  test(`${template} checks itself with the generator's Biome`, () => {
    const directory = join(generator, template);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const config = JSON.parse(readFileSync(join(directory, 'biome.json'), 'utf8'));
    expect(manifest.devDependencies['@biomejs/biome']).toBe(formatterVersion);
    expect(lockedBiome(join(directory, 'bun.lock'))).toBe(formatterVersion);
    expect(config.$schema).toBe(`https://biomejs.dev/schemas/${formatterVersion}/schema.json`);
  });
}
