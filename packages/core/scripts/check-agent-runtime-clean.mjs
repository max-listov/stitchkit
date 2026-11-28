/**
 * Guard (I7): the peer-free `agent-runtime` and `tools` entrypoints must not pull
 * any external AI or model-provider SDK into their built `.js` chunk graph or
 * emitted `.d.ts` declaration closure.
 *
 * Scans the built `dist/` artifact because `--splitting` can place a shared
 * external import into a chunk reachable from a peer-free entry, and a leaked
 * type reference in `.d.ts` forces consumers without optional peers to fail
 * strict declaration checks. → ADR 0336.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from '@typescript/typescript6';

export const PEER_FREE_AGENT_ENTRIES = [
  'entrypoints/agent-runtime',
  'entrypoints/agent-runtime/harness',
  'entrypoints/agent-runtime/coding-tools',
  'entrypoints/agent-runtime/testing',
  'entrypoints/agent-runtime/openrouter',
  'entrypoints/agent-runtime/openai',
  'entrypoints/agent-runtime/anthropic',
  'entrypoints/agent-runtime/sandbox',
  'entrypoints/agent-runtime/browser',
  'entrypoints/agent-runtime/react',
  'entrypoints/agent-runtime/realtime',
  'entrypoints/agent-runtime/postgres',
  'entrypoints/agent-runtime/sqlite/bun',
  'entrypoints/agent-runtime/sqlite/node',
  'entrypoints/tools',
  'entrypoints/tools/connections',
  'entrypoints/tools/mcp',
  'entrypoints/tools/contract',
  'entrypoints/tools/invoker',
];

const FORBIDDEN_EXACT_OR_SUBPATH = ['ai', 'openai', '@anthropic-ai/sdk'];
const FORBIDDEN_SCOPES = ['@ai-sdk/', '@openrouter/'];

/** True when a module specifier targets a forbidden external AI/provider SDK. */
export function isForbiddenAgentPeerSpecifier(specifier) {
  if (FORBIDDEN_SCOPES.some((scope) => specifier.startsWith(scope))) return true;
  return FORBIDDEN_EXACT_OR_SUBPATH.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function isFile(filePath) {
  return Boolean(filePath) && existsSync(filePath) && statSync(filePath).isFile();
}

function resolveRelativeTarget(fromFile, specifier, kind) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates =
    kind === 'dts'
      ? [
          base,
          `${base}.d.ts`,
          base.endsWith('.js') ? `${base.slice(0, -3)}.d.ts` : undefined,
          base.endsWith('.mjs') ? `${base.slice(0, -4)}.d.mts` : undefined,
          join(base, 'index.d.ts'),
        ]
      : [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')];
  return candidates.find((candidate) => isFile(candidate));
}

function extractSpecifiers(filePath, sourceText, kind) {
  const scriptKind = kind === 'dts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  const specifiers = [];
  for (const ref of sourceFile.typeReferenceDirectives) {
    if (ref.fileName) specifiers.push(ref.fileName);
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const first = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteralLike(first)) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function scanEntryGraph({ distRoot, entry, kind }) {
  const entryRel = `${entry}.${kind === 'dts' ? 'd.ts' : 'js'}`;
  const entryPath = resolve(distRoot, entryRel);
  if (!isFile(entryPath)) {
    return {
      files: new Set(),
      violations: [{ entry, kind, file: entryRel, specifier: '<missing-entry>' }],
    };
  }
  const seen = new Set();
  const violations = [];
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const sourceText = readFileSync(current, 'utf8');
    const relFile = relative(distRoot, current).replaceAll('\\', '/');
    for (const specifier of extractSpecifiers(current, sourceText, kind)) {
      if (specifier.startsWith('.')) {
        const next = resolveRelativeTarget(current, specifier, kind);
        if (next?.startsWith(distRoot)) queue.push(next);
        continue;
      }
      if (isForbiddenAgentPeerSpecifier(specifier)) {
        violations.push({ entry, kind, file: relFile, specifier });
      }
    }
  }
  return { files: seen, violations };
}

/**
 * Verify that the built `.js` and `.d.ts` closures of all peer-free agent-runtime
 * and tools entries under `distDir` import no external AI or provider SDKs.
 */
export function checkAgentRuntimeClean(distDir, entries = PEER_FREE_AGENT_ENTRIES) {
  const distRoot = resolve(distDir);
  const jsFiles = new Set();
  const dtsFiles = new Set();
  const violations = [];
  const dedupe = new Set();

  for (const entry of entries) {
    for (const kind of ['js', 'dts']) {
      const result = scanEntryGraph({ distRoot, entry, kind });
      const bucket = kind === 'js' ? jsFiles : dtsFiles;
      for (const file of result.files) bucket.add(file);
      for (const violation of result.violations) {
        const key = `${violation.entry}|${violation.kind}|${violation.file}|${violation.specifier}`;
        if (!dedupe.has(key)) {
          dedupe.add(key);
          violations.push(violation);
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    entriesChecked: entries.length,
    jsFilesScanned: jsFiles.size,
    dtsFilesScanned: dtsFiles.size,
    violations,
  };
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const defaultDist = resolve(dirname(new URL(import.meta.url).pathname), '../dist');
  const targetDist = process.argv[2] ? resolve(process.argv[2]) : defaultDist;
  const result = checkAgentRuntimeClean(targetDist);
  if (!result.ok) {
    console.error(
      '[check-agent-runtime-clean] peer-free agent/tools entries import forbidden SDK(s):',
    );
    for (const v of result.violations) {
      console.error(`  ${v.entry} (${v.kind}) -> ${v.file}: "${v.specifier}"`);
    }
    process.exit(1);
  }
  console.log(
    `[check-agent-runtime-clean] ${result.entriesChecked} peer-free entries clean (${result.jsFilesScanned} js, ${result.dtsFilesScanned} d.ts files scanned)`,
  );
}
