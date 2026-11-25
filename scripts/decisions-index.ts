import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type FenceState, stepFence } from './markdown-fences';

const ROW = /^\| \[(\d{4})\]\((\d{4})-[^)]+\.md\) \|/;
const VALUE = /^(?:I\d+(?:, I\d+)*|P|superseded → (\d{4}))$/;
const BODY_STATUS_LINE = /\*\*Status:\*\*|^\s*(?:[-*]\s+)?(?:\*\*Status\*\*|Status)\s*:/i;
const ADR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?: [+-]\d{2}:\d{2})?)?$/;
/** ADRs from this id onward enforce canonical `type: decision` and `created`/`updated` dates. */
export const MODERN_ADR_FRONTMATTER_FLOOR = 300;

export const AdrStatusSchema = z.enum(['accepted', 'superseded', 'rejected']);
export type AdrStatus = z.infer<typeof AdrStatusSchema>;

export const AdrIdSchema = z.string().regex(/^\d{4}$/, 'ADR id must be four digits');
export const AdrTimestampSchema = z
  .string()
  .regex(ADR_TIMESTAMP, 'must be YYYY-MM-DD or YYYY-MM-DD HH:MM ±HH:MM');

export const AdrFrontmatterSchema = z.looseObject({
  type: z.string().optional(),
  status: AdrStatusSchema,
  date: z.unknown().optional(),
  created: z.unknown().optional(),
  updated: z.unknown().optional(),
  amends: z.array(AdrIdSchema).optional(),
  amendedBy: z.array(AdrIdSchema).optional(),
  supersedes: z.array(AdrIdSchema).optional(),
  supersededBy: z.array(AdrIdSchema).optional(),
});

export interface ParsedAdr {
  readonly adr: string;
  readonly status: AdrStatus;
  readonly amends: readonly string[];
  readonly amendedBy: readonly string[];
  readonly supersedes: readonly string[];
  readonly supersededBy: readonly string[];
}

export interface IndexRow {
  readonly adr: string;
  readonly linkAdr: string;
  readonly cellCount: number;
  readonly decision: string;
  readonly status: string;
  readonly invariant: string;
}

/** The invariant ids the principles page declares, one table row each. */
export function declaredInvariants(principles: string): Set<string> {
  return new Set([...principles.matchAll(/^\| (I\d+) \|/gm)].map((match) => match[1] ?? ''));
}

/** Split a Markdown table row into trimmed cells while preserving escaped `\|`. */
function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeading = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const inner =
    withoutLeading.endsWith('|') && !withoutLeading.endsWith('\\|')
      ? withoutLeading.slice(0, -1)
      : withoutLeading;
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      current += '\\|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** Index rows with their cells; a row missing a column yields its Status cell as `invariant`. */
export function indexRows(index: string): IndexRow[] {
  return index.split('\n').flatMap((line) => {
    const row = ROW.exec(line);
    if (!row) return [];
    const cells = splitTableCells(line);
    return [
      {
        adr: row[1] ?? '',
        linkAdr: row[2] ?? '',
        cellCount: cells.length,
        decision: cells[1] ?? '',
        status: cells[2] ?? '',
        invariant: cells.at(-1) ?? '',
      },
    ];
  });
}

/** Read all `NNNN-*.md` ADR files in a decisions directory, keyed by 4-digit id. */
export function loadDecisionFiles(dir: string): Map<string, string> {
  const files = readdirSync(dir)
    .filter((file) => /^\d{4}-.+\.md$/.test(file))
    .sort();
  const map = new Map<string, string>();
  for (const file of files) {
    map.set(file.slice(0, 4), readFileSync(join(dir, file), 'utf8'));
  }
  return map;
}

function bodyContainsStatusLine(lines: readonly string[]): boolean {
  let fence: FenceState | null = null;
  for (const line of lines) {
    const stepped = stepFence(line, fence);
    fence = stepped.fence;
    if (stepped.isDelimiter || fence !== null) continue;
    if (BODY_STATUS_LINE.test(line)) return true;
  }
  return false;
}

function validateIdList(
  adr: string,
  field: string,
  ids: readonly string[],
  problems: string[],
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === adr) problems.push(`${adr}: ${field} cannot reference itself`);
    if (seen.has(id)) problems.push(`${adr}: duplicate ${id} in ${field}`);
    seen.add(id);
  }
}

/** Parse one ADR file's frontmatter and enforce body hygiene. */
export function parseAdrDocument(
  adr: string,
  source: string,
): { doc?: ParsedAdr; problems: string[] } {
  const problems: string[] = [];
  const lines = source.split('\n');
  const fmEnd =
    lines[0]?.trimEnd() === '---'
      ? lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
      : -1;
  const bodyLines = fmEnd === -1 ? lines : lines.slice(fmEnd + 1);
  if (bodyContainsStatusLine(bodyLines)) {
    problems.push(`${adr}: body contains "**Status:**" (status belongs only in frontmatter)`);
  }
  if (fmEnd === -1) {
    problems.push(`${adr}: missing YAML frontmatter`);
    return { problems };
  }
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(lines.slice(1, fmEnd).join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`${adr}: invalid YAML frontmatter (${message})`);
    return { problems };
  }
  const parsed = AdrFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`)
      .join('; ');
    problems.push(`${adr}: invalid frontmatter (${summary})`);
    return { problems };
  }
  const data = parsed.data;
  if (Number(adr) >= MODERN_ADR_FRONTMATTER_FLOOR) {
    if (data.type !== 'decision') {
      problems.push(
        `${adr}: frontmatter must declare type: "decision" (got ${JSON.stringify(data.type)})`,
      );
    }
    if (Object.hasOwn(data, 'date')) {
      problems.push(`${adr}: frontmatter must use "created"/"updated" instead of "date"`);
    }
    const created = AdrTimestampSchema.safeParse(data.created);
    if (!created.success) {
      problems.push(
        `${adr}: frontmatter requires valid "created" date (${created.error.issues[0]?.message ?? 'invalid'})`,
      );
    }
    const updated = AdrTimestampSchema.safeParse(data.updated);
    if (!updated.success) {
      problems.push(
        `${adr}: frontmatter requires valid "updated" date (${updated.error.issues[0]?.message ?? 'invalid'})`,
      );
    }
  }
  const amends = data.amends ?? [];
  const amendedBy = data.amendedBy ?? [];
  const supersedes = data.supersedes ?? [];
  const supersededBy = data.supersededBy ?? [];
  validateIdList(adr, 'amends', amends, problems);
  validateIdList(adr, 'amendedBy', amendedBy, problems);
  validateIdList(adr, 'supersedes', supersedes, problems);
  validateIdList(adr, 'supersededBy', supersededBy, problems);
  for (const id of amends) {
    if (supersedes.includes(id)) {
      problems.push(`${adr}: ${id} cannot appear in both amends and supersedes`);
    }
  }
  for (const id of amendedBy) {
    if (supersededBy.includes(id)) {
      problems.push(`${adr}: ${id} cannot appear in both amendedBy and supersededBy`);
    }
  }
  if (data.status === 'superseded' && supersededBy.length === 0) {
    problems.push(`${adr}: status is "superseded" without supersededBy`);
  }
  if (data.status !== 'superseded' && supersededBy.length > 0) {
    problems.push(`${adr}: supersededBy requires status "superseded" (got "${data.status}")`);
  }
  return {
    doc: { adr, status: data.status, amends, amendedBy, supersedes, supersededBy },
    problems,
  };
}

/** Canonical Status cell in `docs/decisions/README.md`, derived solely from frontmatter. */
export function expectedStatusCell(doc: ParsedAdr): string {
  const base =
    doc.status === 'accepted'
      ? 'Accepted'
      : doc.status === 'rejected'
        ? 'Rejected'
        : `Superseded by ${[...doc.supersededBy].sort().join(', ')}`;
  if (doc.amendedBy.length === 0) return base;
  return `${base}, amended by ${[...doc.amendedBy].sort().join(', ')}`;
}

/** Verify bidirectional `amends`/`amendedBy` and `supersedes`/`supersededBy` pairs. */
export function checkAdrRelations(docs: ReadonlyMap<string, ParsedAdr>): string[] {
  const problems: string[] = [];
  for (const adr of [...docs.keys()].sort()) {
    const doc = docs.get(adr);
    if (!doc) continue;
    for (const target of doc.amends) {
      const other = docs.get(target);
      if (!other) problems.push(`${adr} amends ${target}: ${target} does not exist`);
      else if (!other.amendedBy.includes(adr))
        problems.push(`${adr} amends ${target}: ${target} has no amendedBy`);
    }
    for (const source of doc.amendedBy) {
      const other = docs.get(source);
      if (!other) problems.push(`${adr} amendedBy ${source}: ${source} does not exist`);
      else if (!other.amends.includes(adr))
        problems.push(`${adr} amendedBy ${source}: ${source} has no amends`);
    }
    for (const target of doc.supersedes) {
      const other = docs.get(target);
      if (!other) problems.push(`${adr} supersedes ${target}: ${target} does not exist`);
      else if (!other.supersededBy.includes(adr))
        problems.push(`${adr} supersedes ${target}: ${target} has no supersededBy`);
    }
    for (const source of doc.supersededBy) {
      const other = docs.get(source);
      if (!other) problems.push(`${adr} supersededBy ${source}: ${source} does not exist`);
      else if (!other.supersedes.includes(adr))
        problems.push(`${adr} supersededBy ${source}: ${source} has no supersedes`);
    }
  }
  return problems;
}

/** Every problem in the index and (when given) ADR files, one line each; empty when sound. */
export function checkDecisionsIndex(
  index: string,
  principles: string,
  files?: ReadonlyMap<string, string>,
): string[] {
  const declared = declaredInvariants(principles);
  const rows = indexRows(index);
  const present = new Set(rows.map((row) => row.adr));
  const problems: string[] = [];
  for (const { adr, linkAdr, cellCount, invariant } of rows) {
    if (adr !== linkAdr) {
      problems.push(`${adr}: link target ${linkAdr} does not match ADR id ${adr}`);
    }
    const value = VALUE.exec(invariant);
    if (cellCount !== 4) {
      if (cellCount === 3 && !value) {
        problems.push(`${adr}: no invariant column (last cell: "${invariant}")`);
      } else {
        problems.push(`${adr}: expected 4 table columns, got ${cellCount}`);
      }
      continue;
    }
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
  if (!files) return problems;

  for (const adr of [...present].sort()) {
    if (!files.has(adr)) {
      problems.push(`${adr}: listed in README.md but ADR file is missing`);
    }
  }
  for (const adr of [...files.keys()].sort()) {
    if (!present.has(adr)) {
      problems.push(`${adr}: ADR file exists but has no row in README.md`);
    }
  }

  const docs = new Map<string, ParsedAdr>();
  for (const adr of [...files.keys()].sort()) {
    const source = files.get(adr);
    if (source === undefined) continue;
    const result = parseAdrDocument(adr, source);
    problems.push(...result.problems);
    if (result.doc) docs.set(adr, result.doc);
  }
  problems.push(...checkAdrRelations(docs));

  for (const row of rows) {
    const doc = docs.get(row.adr);
    if (!doc) continue;
    const expected = expectedStatusCell(doc);
    if (row.status !== expected) {
      problems.push(`${row.adr}: status column is "${row.status}", expected "${expected}"`);
    }
    const supersededMatch = /^superseded → (\d{4})$/.exec(row.invariant);
    if (doc.status === 'superseded') {
      const target = [...doc.supersededBy].sort()[0];
      if (target && supersededMatch?.[1] !== target) {
        problems.push(
          `${row.adr}: superseded ADR invariant column is "${row.invariant}", expected "superseded → ${target}"`,
        );
      }
    } else if (supersededMatch) {
      problems.push(
        `${row.adr}: invariant column says "${row.invariant}" but frontmatter status is "${doc.status}"`,
      );
    }
  }
  return problems;
}
