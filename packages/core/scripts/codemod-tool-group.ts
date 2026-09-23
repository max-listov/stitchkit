/**
 * Codemod for 0.94.0: move an endpoint's tool options into its `tool` group.
 *
 *   bun packages/core/scripts/codemod-tool-group.ts <file-or-dir> [...more]      rewrite in place
 *   bun packages/core/scripts/codemod-tool-group.ts --check <file-or-dir> [...]  list, change nothing
 *
 * An endpoint is an object literal with `method`, `path` and `desc`. On such a
 * literal `toolName`, `ui`, `annotations` and `mcp` move into `tool: { name, ui,
 * annotations, mcp }`, keeping their source text. A runtime tool
 * (`defineRuntimeTool`) has no `path`, and a built `MethodDef` has a `handler`,
 * `serviceName` or `key`; both are left alone — their fields stay flat.
 * An existing `tool` object is extended rather than duplicated; a key written
 * as a shorthand (`{ mcp }`) keeps its value. Nothing else is touched, and an
 * endpoint the codemod cannot rewrite safely — a spread that might carry these
 * keys, a computed key — is reported and left for a person.
 *
 * `defineContract` refuses the old keys at startup with the endpoint's name, so
 * nothing this misses can pass silently. → ADR 0196.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import ts from '@typescript/typescript6';

const MOVED: Record<string, string> = {
  toolName: 'name',
  ui: 'ui',
  annotations: 'annotations',
  mcp: 'mcp',
};
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx']);
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'releases',
  'vendor',
  '.git',
]);

interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface CodemodResult {
  text: string;
  moved: number;
  skipped: string[];
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return undefined;
}

/**
 * An authored endpoint — not an already-built `MethodDef`, which carries the
 * same three keys and keeps its tool fields flat (it has a `handler`, a
 * `serviceName` or a `key`).
 */
function isEndpoint(node: ts.ObjectLiteralExpression): boolean {
  const names = new Set(node.properties.map(propertyName));
  if (names.has('handler') || names.has('serviceName') || names.has('key')) return false;
  return names.has('method') && names.has('path') && names.has('desc');
}

/**
 * An endpoint whose `expose` is a literal list with no tool transport. Its tool
 * options never reached a tool; moved into `tool` they are refused, so the
 * honest edit is deleting them — a person's call, not the codemod's.
 */
function isHttpOnly(node: ts.ObjectLiteralExpression): boolean {
  const expose = node.properties.find((property) => propertyName(property) === 'expose');
  if (!expose || !ts.isPropertyAssignment(expose)) return false;
  let list = expose.initializer;
  while (ts.isAsExpression(list) || ts.isSatisfiesExpression(list)) list = list.expression;
  if (!ts.isArrayLiteralExpression(list)) return false;
  return list.elements.every(
    (element) => ts.isStringLiteralLike(element) && element.text === 'HTTP',
  );
}

/** The comments written above a property, which move with it. */
function leadingComment(text: string, property: ts.ObjectLiteralElementLike): string {
  return text.slice(property.getFullStart(), property.getStart()).trim();
}

/** Rewrite one source text; pure, so the test can feed it literals. */
export function moveToolOptions(fileName: string, text: string): CodemodResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const edits: Edit[] = [];
  const skipped: string[] = [];
  let moved = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && isEndpoint(node)) {
      const toMove = node.properties.filter((property) => {
        const name = propertyName(property);
        return name !== undefined && name in MOVED;
      });
      if (toMove.length > 0) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const unsafe = node.properties.some(
          (property) =>
            ts.isSpreadAssignment(property) ||
            (property.name !== undefined && ts.isComputedPropertyName(property.name)),
        );
        if (unsafe) {
          skipped.push(
            `${fileName}:${line} — a spread or computed key; move the tool options by hand`,
          );
        } else if (isHttpOnly(node)) {
          skipped.push(
            `${fileName}:${line} — exposed on HTTP only, so these tool options never reached a tool; delete them`,
          );
        } else {
          const existing = node.properties.find(
            (property) => propertyName(property) === 'tool',
          );
          if (
            existing &&
            !(
              ts.isPropertyAssignment(existing) &&
              ts.isObjectLiteralExpression(existing.initializer)
            )
          ) {
            skipped.push(
              `${fileName}:${line} — \`tool\` is not an object literal; merge by hand`,
            );
          } else {
            const member = (property: ts.ObjectLiteralElementLike): string => {
              const target = MOVED[propertyName(property) ?? ''] ?? '';
              if (ts.isShorthandPropertyAssignment(property)) {
                return target === property.name.text
                  ? target
                  : `${target}: ${property.name.text}`;
              }
              if (ts.isPropertyAssignment(property)) {
                return `${target}: ${property.initializer.getText(source)}`;
              }
              return `${target}: ${property.getText(source)}`;
            };
            const members = toMove.map((property) => ({
              comment: leadingComment(text, property),
              text: member(property),
            }));
            // A comment cannot sit inside `{ a, b }` on one line, so a group that
            // carries one is written one member per line under the endpoint.
            const commented = members.some(({ comment }) => comment !== '');
            const group = (indent: string, inner: string[] = []): string => {
              const all = [...inner.map((text) => ({ comment: '', text })), ...members];
              if (!commented) return `{ ${all.map(({ text }) => text).join(', ')} }`;
              const lines = all.flatMap(({ comment, text }) => [
                ...(comment === ''
                  ? []
                  : comment.split('\n').map((row) => `${indent}  ${row.trim()}`)),
                `${indent}  ${text},`,
              ]);
              return `{\n${lines.join('\n')}\n${indent}}`;
            };
            for (const property of toMove) {
              const start = property.getFullStart();
              let end = property.getEnd();
              if (text[end] === ',') end += 1;
              edits.push({ start, end, text: '' });
            }
            if (
              existing &&
              ts.isPropertyAssignment(existing) &&
              ts.isObjectLiteralExpression(existing.initializer)
            ) {
              const literal = existing.initializer;
              const inner = literal.properties.map((property) => property.getText(source));
              const indent =
                /\n([ \t]*)[^\n]*$/.exec(text.slice(0, existing.getStart()))?.[1] ?? '';
              edits.push({
                start: literal.getStart(),
                end: literal.getEnd(),
                text: group(indent, inner),
              });
            } else {
              const last = node.properties[node.properties.length - 1];
              const anchor =
                [...node.properties]
                  .reverse()
                  .find((property) => !toMove.includes(property)) ?? last;
              if (anchor) {
                let end = anchor.getEnd();
                const trailingComma = text[end] === ',';
                if (trailingComma) end += 1;
                const indent =
                  /\n([ \t]*)[^\n]*$/.exec(text.slice(0, anchor.getStart()))?.[1] ?? '';
                const multiline = text.slice(node.getStart(), node.getEnd()).includes('\n');
                const insert = multiline
                  ? `${trailingComma ? '' : ','}\n${indent}tool: ${group(indent)},`
                  : `${trailingComma ? '' : ','} tool: ${group(indent)}`;
                edits.push({ start: end, end, text: insert });
              }
            }
            moved += toMove.length;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let next = text;
  for (const edit of edits)
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return { text: next, moved, skipped };
}

export function* files(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (EXTENSIONS.has(extname(path))) yield path;
    return;
  }
  // A socket, FIFO or device left by a running app is neither; a project's
  // runtime state directory holds such files, and reading one as a directory throws.
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    yield* files(join(path, entry));
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const targets = argv.filter((argument) => argument !== '--check');
  if (targets.length === 0) {
    console.error(
      'usage: bun packages/core/scripts/codemod-tool-group.ts [--check] <file-or-dir> [...]',
    );
    process.exit(2);
  }
  let total = 0;
  const skipped: string[] = [];
  for (const target of targets) {
    for (const file of files(target)) {
      const text = readFileSync(file, 'utf8');
      if (!/\b(toolName|ui|annotations|mcp)\s*[:,}]/.test(text)) continue;
      const result = moveToolOptions(file, text);
      skipped.push(...result.skipped);
      if (result.moved === 0) continue;
      total += result.moved;
      console.log(`${check ? 'would move' : 'moved'} ${result.moved} in ${file}`);
      if (!check) writeFileSync(file, result.text);
    }
  }
  for (const line of skipped) console.log(`left for a person: ${line}`);
  console.log(
    `${total} option(s) ${check ? 'to move' : 'moved'}; ${skipped.length} endpoint(s) left`,
  );
}
