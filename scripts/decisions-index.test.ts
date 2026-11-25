import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkAdrRelations,
  checkDecisionsIndex,
  declaredInvariants,
  expectedStatusCell,
  type IndexRow,
  indexRows,
  loadDecisionFiles,
  parseAdrDocument,
} from './decisions-index';

export { checkDecisionsIndex, declaredInvariants, type IndexRow, indexRows };

// Every ADR row names the invariant from docs/PRINCIPLES.md it serves, or is a
// practice/incident record (`P`), or is superseded whole by a named record. Every
// ADR carries YAML frontmatter as its single status source, bidirectional relation
// links, and no duplicate `**Status:**` line in its body.

const DECISIONS = join(import.meta.dir, '../docs/decisions');
const PRINCIPLES = join(import.meta.dir, '../docs/PRINCIPLES.md');
const ROW = /^\| \[(\d{4})\]\((\d{4})-[^)]+\.md\) \|/;

const index = readFileSync(join(DECISIONS, 'README.md'), 'utf8');
const principles = readFileSync(PRINCIPLES, 'utf8');
const decisionFiles = loadDecisionFiles(DECISIONS);
const header = index.split('\n').filter((line) => !ROW.test(line));

function adrDoc(frontmatter: string, body = '# Title\n\n## Decision\n\nBody.\n'): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

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
    expect(rows.length).toBeGreaterThanOrEqual(307);
    expect(rows).toEqual(files);
  });

  test('every ADR renders as a row of one complete Markdown table', () => {
    function tableRows(source: string): number {
      const html = Bun.markdown.html(source);
      const tables = [...html.matchAll(/<table>[\s\S]*?<\/table>/g)];
      expect(tables).toHaveLength(1);
      const table = tables[0]?.[0] ?? '';
      expect(table).toContain('<thead>');
      const headings = [...table.matchAll(/<th>/g)];
      expect(headings).toHaveLength(4);
      return [...table.matchAll(/<tr><td>/g)].length;
    }
    expect(tableRows(index)).toBe(indexRows(index).length);
    const broken = index.replace('\n| [0223]', '\n\n| [0223]');
    expect(tableRows(broken)).toBeLessThan(indexRows(index).length);
    const html = Bun.markdown.html(broken);
    expect(html).toContain('<p>| <a href="0223-');
    for (const line of [
      '| ADR | Decision | Status | Invariant |',
      '|-----|----------|--------|-----------|',
    ]) {
      const missing = index.replace(`${line}\n`, '');
      expect(Bun.markdown.html(missing)).not.toContain('<table>');
      expect(() => tableRows(missing)).toThrow();
    }
  });

  test('every row carries an invariant the page declares, P, or a superseding record', () => {
    expect(checkDecisionsIndex(index, principles, decisionFiles)).toEqual([]);
  });

  test('amends/amendedBy and supersedes/supersededBy pairs match in both directions', () => {
    const docs = new Map(
      [...decisionFiles.entries()].flatMap(([adr, source]) => {
        const { doc } = parseAdrDocument(adr, source);
        return doc ? [[adr, doc] as const] : [];
      }),
    );
    expect(docs.size).toBe(decisionFiles.size);
    expect(checkAdrRelations(docs)).toEqual([]);
  });
});

describe('decisions index: refusals of a malformed index or record', () => {
  test('negative control: an unknown id, a missing column and a dangling target are refused', () => {
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

  test('negative control: one-sided amends/supersedes and dangling back-links are refused', () => {
    const syntheticIndex = [
      ...header,
      '| [0166](0166-old.md) | Old | Accepted | I4 |',
      '| [0280](0280-new.md) | New | Accepted | I4 |',
    ].join('\n');
    const missingBackLink = new Map([
      ['0166', adrDoc('title: Old\ntype: decision\nstatus: accepted')],
      ['0280', adrDoc('title: New\ntype: decision\nstatus: accepted\namends: ["0166"]')],
    ]);
    expect(checkDecisionsIndex(syntheticIndex, principles, missingBackLink)).toEqual([
      '0280 amends 0166: 0166 has no amendedBy',
    ]);

    const danglingBackLinkIndex = [
      ...header,
      '| [0166](0166-old.md) | Old | Accepted, amended by 0280 | I4 |',
      '| [0280](0280-new.md) | New | Accepted | I4 |',
    ].join('\n');
    const danglingBackLink = new Map([
      ['0166', adrDoc('title: Old\ntype: decision\nstatus: accepted\namendedBy: ["0280"]')],
      ['0280', adrDoc('title: New\ntype: decision\nstatus: accepted')],
    ]);
    expect(checkDecisionsIndex(danglingBackLinkIndex, principles, danglingBackLink)).toEqual([
      '0166 amendedBy 0280: 0280 has no amends',
    ]);

    const missingSupersededBackIndex = [
      ...header,
      '| [0004](0004-old.md) | Old | Accepted | I12 |',
      '| [0072](0072-new.md) | New | Accepted | I12 |',
    ].join('\n');
    const missingSupersededBack = new Map([
      ['0004', adrDoc('title: Old\ntype: decision\nstatus: accepted')],
      ['0072', adrDoc('title: New\ntype: decision\nstatus: accepted\nsupersedes: ["0004"]')],
    ]);
    expect(
      checkDecisionsIndex(missingSupersededBackIndex, principles, missingSupersededBack),
    ).toEqual(['0072 supersedes 0004: 0004 has no supersededBy']);
  });

  test('negative control: status drift, missing frontmatter, active status and body **Status:** are refused', () => {
    const syntheticIndex = [
      ...header,
      '| [0001](0001-a.md) | A | Accepted | I1 |',
      '| [0002](0002-b.md) | B | Accepted | I1 |',
      '| [0003](0003-c.md) | C | Accepted | I1 |',
      '| [0004](0004-d.md) | D | Accepted | I1 |',
      '| [0005](0005-e.md) | E | Accepted | I1 |',
    ].join('\n');
    const syntheticFiles = new Map([
      // Index says Accepted while frontmatter says superseded by 0005
      ['0001', adrDoc('title: A\ntype: decision\nstatus: superseded\nsupersededBy: ["0005"]')],
      // Missing frontmatter
      ['0002', '# 0002 — B\n\nBody.\n'],
      // Body still has **Status:**
      [
        '0003',
        adrDoc(
          'title: C\ntype: decision\nstatus: accepted',
          '# 0003 — C\n\n- **Status:** Accepted\n',
        ),
      ],
      // Deprecated `active` status
      ['0004', adrDoc('title: D\ntype: decision\nstatus: active')],
      // Valid superseding target for 0001
      ['0005', adrDoc('title: E\ntype: decision\nstatus: accepted\nsupersedes: ["0001"]')],
    ]);
    const problems = checkDecisionsIndex(syntheticIndex, principles, syntheticFiles);
    expect(problems).toContain(
      '0001: status column is "Accepted", expected "Superseded by 0005"',
    );
    expect(problems).toContain(
      '0001: superseded ADR invariant column is "I1", expected "superseded → 0005"',
    );
    expect(problems).toContain('0002: missing YAML frontmatter');
    expect(problems).toContain(
      '0003: body contains "**Status:**" (status belongs only in frontmatter)',
    );
    expect(problems.some((line) => line.startsWith('0004: invalid frontmatter'))).toBe(true);
    expect(
      expectedStatusCell({
        adr: '0001',
        status: 'accepted',
        amends: [],
        amendedBy: ['0010', '0002'],
        supersedes: [],
        supersededBy: [],
      }),
    ).toBe('Accepted, amended by 0002, 0010');
  });
});

describe('decisions index: refusals on the real tree and of record headers', () => {
  test('negative control: real-tree mutation removing amendedBy from 0166 reddens relation check', () => {
    const mutated = new Map(decisionFiles);
    const original0166 = mutated.get('0166');
    expect(original0166).toContain('amendedBy:');
    mutated.set('0166', (original0166 ?? '').replace(/^amendedBy:.*\n/m, ''));
    const docs = new Map(
      [...mutated.entries()].flatMap(([adr, source]) => {
        const { doc } = parseAdrDocument(adr, source);
        return doc ? [[adr, doc] as const] : [];
      }),
    );
    expect(checkAdrRelations(docs)).toEqual([
      '0280 amends 0166: 0166 has no amendedBy',
      '0282 amends 0166: 0166 has no amendedBy',
    ]);
  });

  test('negative control: self-reference, dangling supersededBy, amends/supersedes overlap, table mismatch and fence bypasses are refused', () => {
    const syntheticIndex = [
      ...header,
      '| [0001](0002-mismatch.md) | A | Accepted | I1 | Extra |',
      '| [0002](0002-b.md) | B | Superseded by 0003 | superseded → 0003 |',
      '| [0003](0003-c.md) | C | Accepted | I1 |',
      '| [0004](0004-d.md) | D | Accepted | I1 |',
      '| [0005](0005-missing.md) | E | Accepted | I1 |',
    ].join('\n');
    const syntheticFiles = new Map([
      [
        '0001',
        adrDoc(
          'title: A\ntype: decision\nstatus: accepted\namends: ["0001", "0002"]\nsupersedes: ["0002"]',
          '# 0001\n\n```inline``` **Status:** Accepted\n',
        ),
      ],
      [
        '0002',
        adrDoc(
          'title: B\ntype: decision\nstatus: superseded\nsupersededBy: ["0003"]',
          '# 0002\n\n- Status: Accepted\n',
        ),
      ],
      [
        '0003',
        adrDoc(
          'title: C\ntype: decision\nstatus: accepted',
          '# 0003\n\n```md\n~~~\n**Status:** inside fence\n```\n**Status:** outside fence\n',
        ),
      ],
      [
        '0004',
        adrDoc(
          'title: D\ntype: decision\nstatus: accepted',
          '# 0004\n\n```md\n~~~\n**Status:** still inside backtick fence\n~~~\n```\n',
        ),
      ],
      ['0006', adrDoc('title: F\ntype: decision\nstatus: accepted')],
    ]);

    const problems = checkDecisionsIndex(syntheticIndex, principles, syntheticFiles);
    expect(problems).toContain('0001: link target 0002 does not match ADR id 0001');
    expect(problems).toContain('0001: expected 4 table columns, got 5');
    expect(problems).toContain('0001: amends cannot reference itself');
    expect(problems).toContain('0001: 0002 cannot appear in both amends and supersedes');
    expect(problems).toContain(
      '0001: body contains "**Status:**" (status belongs only in frontmatter)',
    );
    expect(problems).toContain(
      '0002: body contains "**Status:**" (status belongs only in frontmatter)',
    );
    expect(problems).toContain('0002 supersededBy 0003: 0003 has no supersedes');
    expect(problems).toContain(
      '0003: body contains "**Status:**" (status belongs only in frontmatter)',
    );
    // 0004 has **Status:** strictly inside a backtick fence (not closed by ~~~): must NOT trigger body status error.
    expect(problems.some((line) => line.startsWith('0004: body contains'))).toBe(false);
    expect(problems).toContain('0005: listed in README.md but ADR file is missing');
    expect(problems).toContain('0006: ADR file exists but has no row in README.md');
  });

  test('negative control: ADR >= 0300 requires type: decision and created/updated dates, and refuses date:', () => {
    const syntheticIndex = [
      ...header,
      '| [0299](0299-legacy.md) | Legacy | Accepted | I1 |',
      '| [0300](0300-ok-date.md) | OkDate | Accepted | I1 |',
      '| [0301](0301-ok-ts.md) | OkTs | Accepted | I1 |',
      '| [0302](0302-missing-type-and-date.md) | BadDate | Accepted | I1 |',
      '| [0303](0303-wrong-type-bad-ts.md) | WrongType | Accepted | I1 |',
    ].join('\n');
    const syntheticFiles = new Map([
      // Pre-0300 legacy ADR without type or updated stays accepted.
      ['0299', adrDoc('title: Legacy\nstatus: accepted')],
      // Modern ADR with YYYY-MM-DD dates.
      [
        '0300',
        adrDoc(
          'title: OkDate\ntype: decision\nstatus: accepted\ncreated: 2026-11-24\nupdated: 2026-11-24',
        ),
      ],
      // Modern ADR with full timestamp + offset.
      [
        '0301',
        adrDoc(
          'title: OkTs\ntype: decision\nstatus: accepted\ncreated: 2026-11-24 12:00 +08:00\nupdated: 2026-11-24 12:30 +08:00',
        ),
      ],
      // Missing type and uses `date:` instead of `created`/`updated`.
      ['0302', adrDoc('title: BadDate\nstatus: accepted\ndate: 2026-11-24')],
      // Wrong type and malformed timestamps.
      [
        '0303',
        adrDoc(
          'title: WrongType\ntype: guide\nstatus: accepted\ncreated: 24/11/2026\nupdated: not-a-date',
        ),
      ],
    ]);

    const problems = checkDecisionsIndex(syntheticIndex, principles, syntheticFiles);
    expect(problems.some((line) => line.startsWith('0299:'))).toBe(false);
    expect(problems.some((line) => line.startsWith('0300:'))).toBe(false);
    expect(problems.some((line) => line.startsWith('0301:'))).toBe(false);
    expect(problems).toContain(
      '0302: frontmatter must declare type: "decision" (got undefined)',
    );
    expect(problems).toContain(
      '0302: frontmatter must use "created"/"updated" instead of "date"',
    );
    expect(
      problems.some((line) => line.startsWith('0302: frontmatter requires valid "created"')),
    ).toBe(true);
    expect(
      problems.some((line) => line.startsWith('0302: frontmatter requires valid "updated"')),
    ).toBe(true);
    expect(problems).toContain(
      '0303: frontmatter must declare type: "decision" (got "guide")',
    );
    expect(
      problems.some((line) => line.startsWith('0303: frontmatter requires valid "created"')),
    ).toBe(true);
    expect(
      problems.some((line) => line.startsWith('0303: frontmatter requires valid "updated"')),
    ).toBe(true);
  });

  test('negative control: real-tree mutation reverting 0308 to date: without type reddens index check', () => {
    const mutated = new Map(decisionFiles);
    const original0308 = mutated.get('0308');
    expect(original0308).toContain('type: decision');
    expect(original0308).toContain('created:');
    expect(original0308).toContain('updated:');
    mutated.set(
      '0308',
      (original0308 ?? '')
        .replace(/^type: decision\n/m, '')
        .replace(/^created:.*\n/m, 'date: 2026-11-23\n')
        .replace(/^updated:.*\n/m, ''),
    );
    const problems = checkDecisionsIndex(index, principles, mutated);
    expect(problems).toContain(
      '0308: frontmatter must declare type: "decision" (got undefined)',
    );
    expect(problems).toContain(
      '0308: frontmatter must use "created"/"updated" instead of "date"',
    );
    expect(
      problems.some((line) => line.startsWith('0308: frontmatter requires valid "created"')),
    ).toBe(true);
    expect(
      problems.some((line) => line.startsWith('0308: frontmatter requires valid "updated"')),
    ).toBe(true);
  });
});
