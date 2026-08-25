import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import type { ProjectDeclaration } from '../packages/config/src/project-declaration.generated';
import { assertDeclaredBuildInputs } from './build-inputs';

function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function withInput(path: string, digest: string): ProjectDeclaration {
  const build = appDeclaration.build;
  if (!build) throw new Error('the template declares a build');
  return {
    ...appDeclaration,
    build: { ...build, inputs: [{ name: 'catalogue', path, digest }] },
  };
}

test('this template declares no build inputs, and that is the answer', () => {
  // Not "we forgot to say": the frontend cannot reach a data source at all
  // (`check-authored` refuses the import), so the build is a function of the
  // source alone. If a route ever needs data at build time, it declares it.
  expect(appDeclaration.build?.inputs).toBeUndefined();
  expect(() => assertDeclaredBuildInputs()).not.toThrow();
});

test('a declared input whose bytes changed is refused by name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-inputs-'));
  try {
    await writeFile(join(directory, 'catalogue.json'), '{"items":2}');
    // The digest of what the author froze — not of what is on disk now. This is
    // the whole failure mode: the filename still resolves, so nothing else in
    // the build notices that two builds of one source now differ.
    const stale = digestOf('{"items":1}');
    expect(() =>
      assertDeclaredBuildInputs(withInput('catalogue.json', stale), directory),
    ).toThrow(/"catalogue".*no longer matches its digest/s);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a declared input that matches its digest passes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-inputs-'));
  try {
    const frozen = '{"items":2}';
    await writeFile(join(directory, 'catalogue.json'), frozen);
    expect(() =>
      assertDeclaredBuildInputs(withInput('catalogue.json', digestOf(frozen)), directory),
    ).not.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a declared input that is not there names itself', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'starter-inputs-'));
  try {
    expect(() =>
      assertDeclaredBuildInputs(withInput('catalogue.json', digestOf('{}')), directory),
    ).toThrow(/Declared build input "catalogue" is missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
