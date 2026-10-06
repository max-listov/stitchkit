/**
 * The machine line of a breaking changelog item: what it touches, in a form a
 * consumer's tooling reads without guessing from prose.
 *
 *   **Affects:** `stitchkit/files/packaging` createNativePackaging(delivery: 'embedded')
 *   **Affects:** `stitchkit/contract`, `stitchkit/server` AppError; `stitchkit` ApiError
 *   **Affects:** `stitchkit/process` behaviour
 *   **Affects:** `stitchkit/agent-runtime/harness-tools` *
 *
 * Targets are separated by `; `. A target is one or more backticked entrypoints
 * (`, ` between them) and then either export names (`, ` between them, each with
 * an optional parenthesised qualifier naming the option or member), `behaviour`
 * for a change of semantics no import name reveals, or `*` for every import of
 * the entrypoint (a removed leaf). The whole line stays on one line.
 *
 * Pure: shared by the release gate, which refuses a breaking item without it,
 * and by `stitchkit upgrade`, which matches it against a project's imports.
 */

/** One export a breaking item changes, with what about it changed. */
export interface UpgradeAffectedSymbol {
  readonly name: string;
  /** The option or member the change is about, as written, e.g. `delivery: 'embedded'`. */
  readonly qualifier?: string;
}

/** What one target of an `**Affects:**` line touches in one entrypoint. */
export type UpgradeAffectsTarget =
  | {
      readonly entrypoint: string;
      readonly kind: 'symbols';
      readonly symbols: readonly UpgradeAffectedSymbol[];
    }
  | { readonly entrypoint: string; readonly kind: 'behaviour' }
  | { readonly entrypoint: string; readonly kind: 'any-import' };

/** One top-level `- ` item of a breaking section, with its lines as written. */
export interface UpgradeBreakingItemText {
  readonly markdown: string;
}

const AFFECTS_LINE = /^\s*\*\*Affects:\*\*\s*(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const ENTRYPOINT = /^`(stitchkit(?:\/[a-z0-9][a-z0-9-]*)*)`/;
const SYMBOL = /^([A-Za-z_$][\w$]*)(?:\(([^()]+)\))?$/;

/** The line could not be read; `reason` says which part is malformed. */
export class UpgradeAffectsError extends Error {
  override readonly name = 'UpgradeAffectsError';
}

/**
 * The top-level items of a breaking section. An item opens with a `- `, `* ` or
 * `+ ` bullet at column zero outside a fence; indented and blank lines continue
 * it, and the next unindented line closes it.
 */
export function breakingItems(section: string): UpgradeBreakingItemText[] {
  const items: UpgradeBreakingItemText[] = [];
  let fenced = false;
  let current: string[] | undefined;
  const flush = () => {
    if (current) items.push({ markdown: current.join('\n').trimEnd() });
    current = undefined;
  };
  for (const line of section.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      current?.push(line);
      continue;
    }
    if (fenced) {
      current?.push(line);
      continue;
    }
    if (/^[-*+] /.test(line)) {
      flush();
      current = [line];
    } else if (current && /^\S/.test(line)) {
      flush();
    } else {
      current?.push(line);
    }
  }
  flush();
  return items;
}

/**
 * The text after `**Affects:**` in an item, or undefined when it declares none.
 * An item carries at most one such line; a second is refused, never dropped.
 */
export function affectsLineOf(itemMarkdown: string): string | undefined {
  let fenced = false;
  const lines: string[] = [];
  for (const line of itemMarkdown.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = AFFECTS_LINE.exec(line);
    if (match) lines.push((match[1] ?? '').trim());
  }
  if (lines.length > 1)
    throw new UpgradeAffectsError(
      `the item carries ${lines.length} "**Affects:**" lines; join their targets with "; " on one line`,
    );
  return lines[0];
}

/** Split on `separator` outside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(text.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseTarget(text: string): UpgradeAffectsTarget[] {
  let rest = text.trim();
  const entrypoints: string[] = [];
  for (;;) {
    const match = ENTRYPOINT.exec(rest);
    const name = match?.[1];
    if (!match || name === undefined) break;
    entrypoints.push(name);
    rest = rest.slice(match[0].length);
    if (!rest.startsWith(', `')) break;
    rest = rest.slice(2);
  }
  if (entrypoints.length === 0)
    throw new UpgradeAffectsError(
      `"${text.trim()}" does not start with a backticked stitchkit entrypoint`,
    );
  if (!rest.startsWith(' '))
    throw new UpgradeAffectsError(`"${text.trim()}" names no export, \`behaviour\` or \`*\``);
  const what = rest.trim();
  if (what === 'behaviour')
    return entrypoints.map((entrypoint) => ({ entrypoint, kind: 'behaviour' }));
  if (what === '*')
    return entrypoints.map((entrypoint) => ({ entrypoint, kind: 'any-import' }));
  const symbols = splitTopLevel(what, ', ').map((part): UpgradeAffectedSymbol => {
    const match = SYMBOL.exec(part.trim());
    const name = match?.[1];
    if (!match || name === undefined)
      throw new UpgradeAffectsError(
        `"${part.trim()}" is not an export name with an optional (qualifier)`,
      );
    const qualifier = match[2]?.trim();
    return qualifier ? { name, qualifier } : { name };
  });
  return entrypoints.map((entrypoint) => ({ entrypoint, kind: 'symbols', symbols }));
}

/** Every target of an `**Affects:**` line; throws `UpgradeAffectsError` on a malformed one. */
export function parseAffectsLine(line: string): UpgradeAffectsTarget[] {
  if (line.trim() === '') throw new UpgradeAffectsError('the line names nothing');
  return splitTopLevel(line, '; ').flatMap(parseTarget);
}
