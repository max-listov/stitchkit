/**
 * Guard: the template's mirrored declaration schema cannot fall behind the
 * framework's.
 *
 * A hand-written copy of a schema is a fork that compiles — it diverges and
 * nothing fails. This test is what makes the mirror safe to ship: the copy is
 * generated, and a stale copy is a red gate rather than a silent disagreement
 * between what a project validates and what a deployment reader validates.
 */
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { GENERATED, renderTemplateDeclaration } from './sync-template-declaration';

test('the template mirror matches the framework schema byte for byte', async () => {
  expect(await readFile(GENERATED, 'utf8')).toBe(await renderTemplateDeclaration());
});

test('the mirror says it is generated, so nobody edits it by hand', async () => {
  expect(await readFile(GENERATED, 'utf8')).toStartWith('// GENERATED FILE — do not edit.');
});
