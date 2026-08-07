/**
 * A type a consumer can be required to name is public.
 *
 * `ToolCallContext` broke this in 0.30: it was part of a shipped hook options
 * shape and exported from nowhere, so the consumer who hit it recovered the type
 * through `Parameters<NonNullable<ToolCallHooks['afterToolCall']>>[0]`. Sweeping
 * afterwards found three more of exactly that shape, which is what makes it a
 * class rather than a slip — and a class wants a check, not four fixes.
 *
 * The rule: every type **named in a public signature** must be exported from
 * **some** published entrypoint. Not necessarily the same one — this is a
 * multi-entry package and `stitchkit/tools` naming `ServiceDef` from
 * `stitchkit/server` is how it is meant to work. What must never happen is a
 * type a consumer has to write down that no import can reach.
 *
 * Read off the emitted declarations, because those are precisely what a
 * consumer sees.
 *
 * Runs after `build`, on `dist`. Usage: `bun scripts/check-public-types.mjs`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// TypeScript 7.0 ships the CLI without the compiler API. Keep the latest CLI
// for project builds and use the official side-by-side API package for this
// semantic declaration walk. Replace this import with `typescript` once its
// package exposes `createProgram` again (expected from TypeScript 7.1).
import ts from '@typescript/typescript6';

const pkgRoot = join(import.meta.dirname, '..');
const distDir = join(pkgRoot, 'dist');

/** The published entrypoints, by the specifier a consumer writes. */
const ENTRYPOINTS = {
  stitchkit: 'index.d.ts',
  'stitchkit/contract': 'contract/index.d.ts',
  'stitchkit/server': 'server/index.d.ts',
  'stitchkit/node': 'node.d.ts',
  'stitchkit/tools': 'tools.d.ts',
  'stitchkit/cli': 'cli.d.ts',
  'stitchkit/observability': 'observability/index.d.ts',
  'stitchkit/react': 'react.d.ts',
};

/**
 * Names that are reachable but deliberately not re-exported, each with the
 * reason. An entry here is a decision; anything *not* here is a finding.
 */
const ACCEPTED = {
  // (Peer-owned types — `McpServer`, `ToolSet`, socket.io's `Server`, zod's —
  // need no entry: they are not declared inside `dist`, so they never reach
  // this list. The check only ever asks about types this package owns.)

  // Inference helpers. They sit in a parameter position, but the consumer never
  // writes one — the compiler computes it from the contract. Exporting them
  // would promise stability for machinery that exists to be rearranged.
  ScopedKeys: 'inference helper — the scoped client computes it from the contract',
  ParamValue: 'inference helper — what a query param may be',
  ParamArrayValue: 'inference helper — what a repeated query param may be',
  ControlledKeys: 'inference helper — cursor keys the hook owns',
  CursorParam: 'inference helper — the cursor field, derived from the contract',
  WithStaticContext: 'inference helper — toolkit context shape',
  WithAuthContext: 'inference helper — toolkit context shape',

  // Members of an exported union. Narrow `EndpointDef` with its discriminant
  // (`expose`, `rawResponse`, `rawBody`, `responseMeta`), not by naming the member.
  HttpOnlyEndpointDef: 'member of the exported EndpointDef union',
  ToolEndpointDef: 'member of the exported EndpointDef union',
  RawResponseEndpointDef: 'member of the exported EndpointDef union',
  RawBodyEndpointDef: 'member of the exported EndpointDef union',
  ResponseMetaDataEndpointDef: 'member of the exported EndpointDef union',
  ResponseMetaEmptyEndpointDef: 'member of the exported EndpointDef union',
  ResponseMetaRawBodyDataEndpointDef: 'member of the exported EndpointDef union',
  ResponseMetaRawBodyEmptyEndpointDef: 'member of the exported EndpointDef union',

  // Local aliases over `@types/bun`. A consumer on Bun names Bun's own types;
  // re-exporting ours would fork them. → ADR 0013.
  BunServeOptions: 'alias over @types/bun',
  BunRoutes: 'alias over @types/bun',
  BunWebSocketHandlers: 'alias over @types/bun',
  BunDevelopmentOptions: 'alias over @types/bun',
};

if (!existsSync(distDir)) {
  console.error('[check-public-types] no dist/ — run the build first');
  process.exit(1);
}

const roots = Object.values(ENTRYPOINTS).map((f) => join(distDir, f));
const missing = roots.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error(`[check-public-types] missing declarations:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const program = ts.createProgram(roots, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();

/** Follow an alias so a re-export resolves to the declaration it points at. */
function actual(symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Note an accepted name as seen, and report whether it is accepted at all. */
function markAccepted(name) {
  if (!(name in ACCEPTED)) return false;
  acceptedSeen.add(name);
  return true;
}

/** Where a symbol is declared, or undefined for something ambient. */
function declaredIn(symbol) {
  return symbol.declarations?.[0]?.getSourceFile().fileName;
}

// Pass one: everything a consumer can name, from anywhere in the package.
const reachable = new Set();
const reachableNames = new Set();
for (const file of Object.values(ENTRYPOINTS)) {
  const source = program.getSourceFile(join(distDir, file));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
    reachable.add(actual(symbol));
    reachableNames.add(symbol.getName());
  }
}

const findings = [];
/** Accepted names actually seen — so the allowlist cannot quietly rot. */
const acceptedSeen = new Set();

for (const [specifier, file] of Object.entries(ENTRYPOINTS)) {
  const source = program.getSourceFile(join(distDir, file));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    console.error(`[check-public-types] cannot read the exports of ${specifier}`);
    process.exit(1);
  }

  const exported = checker.getExportsOfModule(moduleSymbol);

  // Every type name mentioned inside this entrypoint's exported declarations —
  // but only where a consumer would have to *write* it: a parameter, a return, a
  // property. Conditional / mapped / indexed / `infer` constructs are the type
  // system computing for you, and the helper names inside them are nobody's to
  // import; flagging those would bury the real finding under twenty aliases.
  for (const symbol of exported) {
    for (const declaration of actual(symbol).declarations ?? []) {
      const walk = (node, computed) => {
        const inMachinery =
          computed ||
          ts.isConditionalTypeNode(node) ||
          ts.isMappedTypeNode(node) ||
          ts.isIndexedAccessTypeNode(node) ||
          ts.isTypeOperatorNode(node) ||
          ts.isInferTypeNode(node);
        if (
          !inMachinery &&
          (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node))
        ) {
          const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
          const referenced = checker.getSymbolAtLocation(name);
          if (referenced) {
            const target = actual(referenced);
            const where = declaredIn(target);
            const ours = where?.startsWith(distDir);
            const named = target.getName();
            if (
              ours &&
              !reachable.has(target) &&
              !reachableNames.has(named) &&
              !markAccepted(named) &&
              // A type parameter is scoped to its own declaration, not a module export.
              !(target.flags & ts.SymbolFlags.TypeParameter)
            ) {
              findings.push({
                specifier,
                name: named,
                via: symbol.getName(),
                where: where.slice(distDir.length + 1),
              });
            }
          }
        }
        ts.forEachChild(node, (child) => walk(child, inMachinery));
      };
      walk(declaration, false);
    }
  }
}

// One line per (entrypoint, type) — the same type reached through five exports
// is one problem.
const unique = new Map();
for (const f of findings) {
  const key = `${f.specifier}:${f.name}`;
  if (!unique.has(key)) unique.set(key, f);
}

if (unique.size > 0) {
  console.error(
    '[check-public-types] named in a public signature but exported from no entrypoint:',
  );
  for (const f of [...unique.values()].sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  )) {
    console.error(`  ${f.specifier}  →  ${f.name}   (via ${f.via}, declared in ${f.where})`);
  }
  console.error(
    '\n  Export it from the entrypoint it belongs to, or add it to ACCEPTED with the reason it stays internal.',
  );
  process.exit(1);
}

const unused = Object.keys(ACCEPTED).filter((n) => !acceptedSeen.has(n));
if (unused.length > 0) {
  console.log(
    `[check-public-types] no longer referenced — drop from ACCEPTED: ${unused.join(', ')}`,
  );
}
console.log('[check-public-types] every type a consumer must name is exported');
