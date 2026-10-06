/**
 * Whether a breaking item touches one project: the plan's `**Affects:**` lines
 * against the names the project imports from `stitchkit`.
 *
 * Pure over source text. The scanner reads static `import`/`export … from`
 * declarations at a statement start (named, aliased, `type`, default, namespace,
 * `export *`), bare imports, and `import()` / `require()` of a literal specifier,
 * and the script blocks of `.vue` and `.svelte` files. Comments and the contents
 * of strings and templates are blanked first, so a commented-out import or one
 * written inside a string is not a use; it does not evaluate code, so a
 * specifier built at run time is invisible to it, and a regular-expression literal that holds a
 * quote or a comment marker can hide what follows it.
 */
import type { UpgradeAffectsTarget } from './upgrade-affects';
import type { UpgradeBreakingItem } from './upgrade-plan';

/** One project file, by a path relative to the project root. */
export interface ProjectSource {
  readonly path: string;
  readonly text: string;
}

/** One name a file imports from one stitchkit entrypoint; `*` for a namespace, star or dynamic import. */
export interface StitchkitImport {
  readonly path: string;
  readonly line: number;
  readonly entrypoint: string;
  readonly name: string;
}

export type UpgradeVerdict =
  | { readonly kind: 'affects'; readonly uses: readonly StitchkitImport[] }
  | { readonly kind: 'not-used' }
  | { readonly kind: 'behavioural'; readonly files: readonly string[] }
  | { readonly kind: 'not-declared'; readonly files: readonly string[] };

export interface UpgradeItemVerdict {
  readonly item: UpgradeBreakingItem;
  readonly verdict: UpgradeVerdict;
}

const SPECIFIER = /^stitchkit(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * The source as the scanner reads it: comments and the contents of every string and template
 * literal replaced by spaces (newlines kept, so offsets and lines are unchanged), and each
 * quoted string's original contents by the offset of its opening quote. Specifiers are looked
 * up there, so an import written inside a string or a template never counts.
 */
function masked(text: string): { code: string; strings: Map<number, string> } {
  const strings = new Map<number, string>();
  const blank = (part: string) => part.replace(/[^\n]/g, ' ');
  let code = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1];
    if (char === '"' || char === "'" || char === '`') {
      let end = index + 1;
      let value = '';
      while (end < text.length && text[end] !== char) {
        if (text[end] === '\\') {
          value += text.slice(end, end + 2);
          end += 2;
          continue;
        }
        if (char !== '`' && text[end] === '\n') break;
        value += text[end];
        end++;
      }
      if (char !== '`') strings.set(index, value);
      code += `${char}${blank(text.slice(index + 1, end))}${text[end] === char ? char : ''}`;
      index = text[end] === char ? end + 1 : end;
      continue;
    }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      code += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      code += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    code += char;
    index++;
  }
  return { code, strings };
}

/** A Vue or Svelte component's script blocks, everything else blanked with its lines kept. */
function scriptBlocks(text: string): string {
  let out = '';
  let at = 0;
  for (const match of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    out += text.slice(at, start).replace(/[^\n]/g, ' ') + (match[2] ?? '');
    at = start + (match[2]?.length ?? 0);
  }
  return out + text.slice(at).replace(/[^\n]/g, ' ');
}

/** The 1-based line of an offset, by binary search over the offsets where lines start. */
function lineLocator(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1))
    starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** Names a declaration clause brings in from its specifier, each with its offset in the clause. */
function clauseNames(clause: string): { name: string; at: number }[] {
  const names: { name: string; at: number }[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces?.[1] !== undefined) {
    let at = (braces.index ?? 0) + 1;
    for (const part of braces[1].split(',')) {
      const match = /^(\s*)(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(part);
      if (match?.[2]) names.push({ name: match[2], at: at + (match[1]?.length ?? 0) });
      at += part.length + 1;
    }
  }
  const star = /\*/.exec(clause.replace(/\{[^}]*\}/, (block) => ' '.repeat(block.length)));
  if (star) names.push({ name: '*', at: star.index ?? 0 });
  const head = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
  // A default import names the module's default export; stitchkit has none, so it is the namespace.
  if (head?.[1] && head[1] !== 'type') names.push({ name: '*', at: head.index ?? 0 });
  return names;
}

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const CLAUSE = `(?:${IDENTIFIER}\\s*,\\s*)?(?:\\{[^{}'"\`;]*\\}|\\*(?:\\s+as\\s+${IDENTIFIER})?)|${IDENTIFIER}`;
/** `import`/`export` … `from` at a statement start, with a clause of the module grammar only. */
const DECLARATION = new RegExp(
  `(?:^|[;}])[ \\t]*(import|export)(\\s+type)?(\\s+(?:${CLAUSE})\\s*|\\s*\\{[^{}'"\`;]*\\}\\s*|\\s*\\*(?:\\s+as\\s+${IDENTIFIER})?\\s*)from\\s*(['"])`,
  'gm',
);
const BARE = /(?:^|[;}])[ \t]*import\s*(['"])/gm;
const DYNAMIC = /\b(?:import|require)\s*\(\s*(['"])/g;

/** The offset of the quote a match ends with. */
const quoteAt = (match: RegExpMatchArray) => (match.index ?? 0) + match[0].length - 1;

/** Every name the given sources import from a `stitchkit` entrypoint. */
export function scanStitchkitImports(sources: readonly ProjectSource[]): StitchkitImport[] {
  const found: StitchkitImport[] = [];
  for (const { path, text: raw } of sources) {
    // A byte order mark is not part of the first statement.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const source = /\.(?:vue|svelte)$/.test(path) ? scriptBlocks(text) : text;
    const { code, strings } = masked(source);
    const lineAt = lineLocator(code);
    const specifierAt = (match: RegExpMatchArray) => {
      const specifier = strings.get(quoteAt(match));
      return specifier !== undefined && SPECIFIER.test(specifier) ? specifier : undefined;
    };
    for (const match of code.matchAll(DECLARATION)) {
      const entrypoint = specifierAt(match);
      if (entrypoint === undefined) continue;
      const clause = match[3] ?? '';
      // The clause ends where the `from` keyword starts.
      const clauseStart = (match.index ?? 0) + match[0].lastIndexOf('from') - clause.length;
      for (const { name, at } of clauseNames(clause))
        found.push({ path, line: lineAt(clauseStart + at), entrypoint, name });
    }
    for (const pattern of [BARE, DYNAMIC])
      for (const match of code.matchAll(pattern)) {
        const entrypoint = specifierAt(match);
        if (entrypoint !== undefined)
          found.push({ path, line: lineAt(quoteAt(match)), entrypoint, name: '*' });
      }
  }
  return found.sort((left, right) =>
    left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1,
  );
}

const filesImporting = (imports: readonly StitchkitImport[], entrypoints: readonly string[]) =>
  [
    ...new Set(
      imports.filter((use) => entrypoints.includes(use.entrypoint)).map((use) => use.path),
    ),
  ].sort();

function usesOf(
  target: UpgradeAffectsTarget,
  imports: readonly StitchkitImport[],
): StitchkitImport[] {
  if (target.kind === 'behaviour') return [];
  const names =
    target.kind === 'symbols'
      ? new Set(target.symbols.map((symbol) => symbol.name))
      : undefined;
  return imports.filter(
    (use) =>
      use.entrypoint === target.entrypoint &&
      (names === undefined || use.name === '*' || names.has(use.name)),
  );
}

/** One verdict per item, in plan order. */
export function upgradeVerdicts(
  items: readonly UpgradeBreakingItem[],
  imports: readonly StitchkitImport[],
): UpgradeItemVerdict[] {
  return items.map((item): UpgradeItemVerdict => {
    if (item.affects === undefined)
      return {
        item,
        verdict: { kind: 'not-declared', files: filesImporting(imports, item.entrypoints) },
      };
    const uses = item.affects.flatMap((target) => usesOf(target, imports));
    if (uses.length > 0) return { item, verdict: { kind: 'affects', uses } };
    const behavioural = item.affects.filter((target) => target.kind === 'behaviour');
    const files = filesImporting(
      imports,
      behavioural.map((target) => target.entrypoint),
    );
    if (files.length > 0) return { item, verdict: { kind: 'behavioural', files } };
    return { item, verdict: { kind: 'not-used' } };
  });
}

const VERDICT_TEXT = {
  affects: 'affects this project',
  'not-used': 'not used here',
  behavioural: 'behavioural — check by hand',
  'not-declared': 'not declared — check by hand',
} satisfies Record<UpgradeVerdict['kind'], string>;

/** The verdicts as the Markdown section `stitchkit upgrade` prints after the plan. */
export function renderUpgradeVerdicts(verdicts: readonly UpgradeItemVerdict[]): string {
  if (verdicts.length === 0) return '';
  const lines = ['## Does it touch this project?', ''];
  for (const { item, verdict } of verdicts) {
    const where =
      item.entrypoints.length > 0
        ? ` ${item.entrypoints.map((name) => `\`${name}\``).join(', ')}`
        : '';
    lines.push(
      `- **${item.version}**${where} — ${item.title}: **${VERDICT_TEXT[verdict.kind]}**`,
    );
    if (verdict.kind === 'affects')
      for (const use of verdict.uses)
        lines.push(
          `  - ${use.path}:${use.line} ${use.name === '*' ? `every import of \`${use.entrypoint}\`` : `\`${use.name}\``}`,
        );
    if (verdict.kind === 'behavioural' || verdict.kind === 'not-declared')
      for (const file of verdict.files) lines.push(`  - ${file}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The verdicts as the `--json` document's items. */
export function upgradeVerdictsJson(verdicts: readonly UpgradeItemVerdict[]) {
  return verdicts.map(({ item, verdict }) => ({
    version: item.version,
    entrypoints: item.entrypoints,
    title: item.title,
    whoMustAct: item.whoMustAct,
    affects: item.affects ?? null,
    verdict: verdict.kind,
    ...(verdict.kind === 'affects' && { uses: verdict.uses }),
    ...((verdict.kind === 'behavioural' || verdict.kind === 'not-declared') && {
      files: verdict.files,
    }),
  }));
}
