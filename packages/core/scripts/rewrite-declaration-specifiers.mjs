/**
 * Make emitted ESM declarations resolvable by NodeNext consumers.
 *
 * Source is compiled with bundler resolution so browser and server entrypoints
 * can keep their established extensionless imports. TypeScript preserves those
 * specifiers in `.d.ts`, while NodeNext correctly requires the ESM file that a
 * relative declaration import represents. Resolve against the completed
 * declaration tree and write the corresponding `.js` specifier; a directory
 * declaration points at its explicit `index.js`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from '@typescript/typescript6';

const dist = resolve(import.meta.dirname, '..', 'dist');

function declarationFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

function resolvedSpecifier(file, specifier) {
  if (!specifier.startsWith('.') || /\.(?:[cm]?js|json|node)$/.test(specifier)) {
    return specifier;
  }
  const target = resolve(dirname(file), specifier);
  if (existsSync(`${target}.d.ts`)) return `${specifier}.js`;
  if (existsSync(join(target, 'index.d.ts'))) return `${specifier}/index.js`;
  throw new Error(
    `[rewrite-declaration-specifiers] ${file} references unresolved relative declaration ${JSON.stringify(specifier)}`,
  );
}

function moduleSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier : undefined;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return ts.isStringLiteral(node.argument.literal) ? node.argument.literal : undefined;
  }
  if (ts.isExternalModuleReference(node) && node.expression) {
    return ts.isStringLiteral(node.expression) ? node.expression : undefined;
  }
  return undefined;
}

let rewrittenFiles = 0;
let rewrittenSpecifiers = 0;
for (const file of declarationFiles(dist)) {
  const sourceText = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const replacements = [];
  const visit = (node) => {
    const literal = moduleSpecifier(node);
    if (literal) {
      const next = resolvedSpecifier(file, literal.text);
      if (next !== literal.text) {
        replacements.push({
          start: literal.getStart(source) + 1,
          end: literal.getEnd() - 1,
          next,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (replacements.length === 0) continue;
  let output = sourceText;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.next}${output.slice(replacement.end)}`;
  }
  writeFileSync(file, output);
  rewrittenFiles += 1;
  rewrittenSpecifiers += replacements.length;
}

console.log(
  `[rewrite-declaration-specifiers] ${rewrittenSpecifiers} specifiers in ${rewrittenFiles} declaration files`,
);
