import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every ADR row names the invariant from docs/PRINCIPLES.md it serves, or is a
// practice/incident record (`P`), or is superseded whole by a named record. An
// id the page does not declare is a claim nothing backs, so it is refused.

const DECISIONS = join(import.meta.dir, '../docs/decisions');
const PRINCIPLES = join(import.meta.dir, '../docs/PRINCIPLES.md');

const ROW = /^\| \[(\d{4})\]\((\d{4})-[^)]+\.md\) \|/;
const VALUE = /^(?:I\d+(?:, I\d+)*|P|superseded → (\d{4}))$/;

/** The invariant ids the principles page declares, one table row each. */
export function declaredInvariants(principles: string): Set<string> {
  return new Set([...principles.matchAll(/^\| (I\d+) \|/gm)].map((match) => match[1] ?? ''));
}

export interface IndexRow {
  adr: string;
  invariant: string;
}

/** Index rows with their last cell; a row missing the column yields its Status cell. */
export function indexRows(index: string): IndexRow[] {
  return index.split('\n').flatMap((line) => {
    const row = ROW.exec(line);
    if (!row) return [];
    const cells = line.replace(/ \|$/, '').split(' | ');
    return [{ adr: row[1] ?? '', invariant: (cells.at(-1) ?? '').trim() }];
  });
}

/** Every problem in the index, as one line each; empty when the index is sound. */
export function checkDecisionsIndex(index: string, principles: string): string[] {
  const declared = declaredInvariants(principles);
  const rows = indexRows(index);
  const present = new Set(rows.map((row) => row.adr));
  const problems: string[] = [];
  for (const { adr, invariant } of rows) {
    const value = VALUE.exec(invariant);
    if (!value) {
      problems.push(`${adr}: no invariant column (last cell: "${invariant}")`);
      continue;
    }
    const target = value[1];
    if (target !== undefined) {
      if (!present.has(target))
        problems.push(`${adr}: superseded by ${target}, which has no row`);
      continue;
    }
    for (const id of invariant.split(', ')) {
      if (id !== 'P' && !declared.has(id)) {
        problems.push(`${adr}: ${id} is not declared in PRINCIPLES.md`);
      }
    }
  }
  return problems;
}

const index = readFileSync(join(DECISIONS, 'README.md'), 'utf8');
const principles = readFileSync(PRINCIPLES, 'utf8');

describe('decisions index ↔ principles', () => {
  test('the principles page declares I1…I15, each once', () => {
    const ids = [...principles.matchAll(/^\| (I\d+) \|/gm)].map((match) => match[1]);
    expect(ids).toEqual(Array.from({ length: 15 }, (_, i) => `I${i + 1}`));
  });

  test('the index has one row per ADR file, and the check saw all of them', () => {
    const files = readdirSync(DECISIONS)
      .filter((file) => /^\d{4}-.+\.md$/.test(file))
      .map((file) => file.slice(0, 4))
      .sort();
    const rows = indexRows(index).map((row) => row.adr);
    // A scanning gate states what it scanned (ADR 0146): an empty parse is not clean.
    expect(rows.length).toBeGreaterThanOrEqual(196);
    expect(rows).toEqual(files);
  });

  test('every row carries an invariant the page declares, P, or a superseding record', () => {
    expect(checkDecisionsIndex(index, principles)).toEqual([]);
  });

  test('negative control: an unknown id, a missing column and a dangling target are refused', () => {
    const header = index.split('\n').filter((line) => !ROW.test(line));
    const rows = [
      '| [0001](0001-a.md) | A | Accepted | I1, I99 |',
      '| [0002](0002-b.md) | B | Accepted |',
      '| [0003](0003-c.md) | C | Superseded by 0404 | superseded → 0404 |',
      '| [0004](0004-d.md) | D | Accepted | P |',
    ];
    expect(checkDecisionsIndex([...header, ...rows].join('\n'), principles)).toEqual([
      '0001: I99 is not declared in PRINCIPLES.md',
      '0002: no invariant column (last cell: "Accepted")',
      '0003: superseded by 0404, which has no row',
    ]);
  });

  test('negative control: removing an id from the page reddens every row that cites it', () => {
    const withoutI15 = principles.replace(/^\| I15 \|.*$/m, '');
    const problems = checkDecisionsIndex(index, withoutI15);
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.every((problem) => problem.endsWith('I15 is not declared in PRINCIPLES.md')),
    ).toBe(true);
  });
});
