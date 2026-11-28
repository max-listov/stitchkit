/**
 * Every emitted declaration, typechecked the way a strict consumer reads it.
 *
 * A type can be correct in source and broken only once it is *written down*.
 * `createAsyncOperationSnapshotSchema` built its object shapes with a
 * conditional spread: TypeScript keeps that shape internal while checking
 * `src`, so nothing here saw it, and wrote it into the declaration as a union
 * zod's shape constraint rejects — five `TS2344` errors, one per phase, in the
 * entrypoint that exists specifically for consumers. The same construction also
 * erased a type argument to `unknown`, which no error reports at all.
 *
 * Both shipped in 0.78.0 and again in 0.79.0. The consumer lane does catch this
 * class, and did print it — but it runs at release time, after packing and
 * installing, which is the last place you want to learn that a declaration does
 * not compile. This is the same question asked four seconds after the file is
 * written, against the same `dist` the lane will later pack.
 *
 * Scope is deliberately our own output. A consumer's own `skipLibCheck: false`
 * run also lights up `react-query-kit` and `grammy`; those are their
 * declarations, not ours, and an optional peer that is simply absent is the
 * consumer lane's judgement to make (`ACCEPTED_UNRESOLVED`), not this gate's.
 *
 * → ADR 0161.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import ts from '@typescript/typescript6';
import { ENTRYPOINTS } from '../entrypoints.mjs';

const require = createRequire(import.meta.url);
const pkgRoot = resolve(import.meta.dirname, '..');
const dist = join(pkgRoot, 'dist');
// The built entry, not its `.d.ts`. TypeScript resolves the sibling declaration
// itself, and importing a `.d.ts` by path is `TS2846` — a diagnostic about the
// probe rather than about the package.
const entryOf = (source) => join(dist, source.replace(/^src\//, '').replace(/\.tsx?$/, '.js'));

function runTsc(cwd, args) {
  try {
    const stdout = execFileSync('bunx', ['tsc', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // A compiler that reported diagnostics ran. One that was killed or missing
    // did not, and "no output" from it must never read as "clean" — the consumer
    // lane learned that the expensive way.
    const ran = typeof error.status === 'number' && output.trim().length > 0;
    if (!ran) {
      const why =
        error.signal !== null && error.signal !== undefined
          ? `killed by ${error.signal}`
          : `did not run (${error.code ?? error.message ?? 'unknown failure'})`;
      console.error(
        `[check-declarations-strict] tsc ${why} — a typecheck that did not happen is not a passing typecheck\n${output}`,
      );
      process.exit(1);
    }
    return { ok: false, output };
  }
}

function checkStrictEntrypoints(workdir) {
  // `export * as` rather than `import type * as`: a namespace re-export pulls the
  // whole declaration into the program and produces no diagnostic of its own, so
  // anything the compiler says is about the package.
  const lines = ENTRYPOINTS.map(
    (entry, index) => `export * as E${index} from ${JSON.stringify(entryOf(entry.source))};`,
  );
  writeFileSync(join(workdir, 'all.ts'), `${lines.join('\n')}\n`);
  writeFileSync(
    join(workdir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          // A consumer's lib is theirs; DOM is the permissive choice, so a
          // diagnostic here is never about a lib we failed to guess.
          lib: ['ES2023', 'DOM'],
          module: 'Preserve',
          moduleResolution: 'bundler',
          noEmit: true,
          skipLibCheck: false,
          types: [],
          typeRoots: [join(pkgRoot, '..', '..', 'node_modules', '@types')],
        },
        include: ['all.ts'],
      },
      null,
      2,
    )}\n`,
  );

  const { output } = runTsc(workdir, ['--noEmit', '-p', 'tsconfig.json']);

  // `DECLARATION_GATE_DEBUG=1` prints what `tsc` actually said and keeps the
  // probe directory. A gate that finds nothing and a gate that is looking in the
  // wrong place read identically from outside, and this one was the second twice
  // before its own positive control said so.
  if (process.env.DECLARATION_GATE_DEBUG) console.error(output);

  // Keyed on the diagnostic's own file, **resolved**, never on the printed text.
  // Two ways to get this wrong and this gate made both. A substring test over the
  // whole line matches paths `tsc` quotes inside its prose ("Did you mean to
  // import 'dist/index.js'"), which attributes the probe's own errors to the
  // package. And `tsc` prints a diagnostic's file relative to the working
  // directory — `../../workspace/project/dist/…` — so comparing against an absolute
  // `dist` matches nothing and the gate reports clean over a defect it is holding
  // in its hand. Resolving both sides is the only comparison that is about files.
  const ours = output.split('\n').filter((line) => {
    if (!/error TS\d+:/.test(line)) return false;
    const at = line.indexOf('(');
    if (at <= 0) return false;
    return resolve(workdir, line.slice(0, at)).startsWith(`${dist}${sep}`);
  });
  if (ours.length === 0) return true;
  console.error(
    `[check-declarations-strict] ${ours.length} diagnostic(s) a strict consumer would read:`,
  );
  for (const line of ours) {
    const at = line.indexOf('(');
    console.error(
      `  dist/${resolve(workdir, line.slice(0, at)).slice(dist.length + 1)}${line.slice(at)}`,
    );
  }
  return false;
}

function prepareConsumerNodeModules(workdir) {
  const nm = join(workdir, 'node_modules');
  mkdirSync(nm, { recursive: true });
  symlinkSync(pkgRoot, join(nm, 'stitchkit'), 'dir');
  symlinkSync(dirname(require.resolve('zod/package.json')), join(nm, 'zod'), 'dir');
}

function checkDxExactOptional(workdir) {
  const dxPath = join(pkgRoot, 'tests', 'agent-runtime-dx.type-test.ts');
  const raw = readFileSync(dxPath, 'utf8');
  let rewrites = 0;
  const consumerSource = raw.replaceAll(
    /from '\.\.\/src\/entrypoints\/([^']+)'/g,
    (_, sub) => {
      rewrites += 1;
      return sub === 'index' ? "from 'stitchkit'" : `from 'stitchkit/${sub}'`;
    },
  );
  if (rewrites === 0) {
    console.error('[check-declarations-strict] DX type-test import rewrite matched 0 imports');
    return false;
  }
  writeFileSync(join(workdir, 'dx-exact-optional.ts'), consumerSource);
  writeFileSync(
    join(workdir, 'tsconfig.dx.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          target: 'ES2022',
          lib: ['ES2023', 'DOM'],
          module: 'Preserve',
          moduleResolution: 'bundler',
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['dx-exact-optional.ts'],
      },
      null,
      2,
    )}\n`,
  );
  const result = runTsc(workdir, ['--noEmit', '-p', 'tsconfig.dx.json']);
  if (process.env.DECLARATION_GATE_DEBUG && result.output) console.error(result.output);
  if (result.ok) return true;
  console.error(
    `[check-declarations-strict] agent-runtime-dx.type-test.ts failed under --exactOptionalPropertyTypes:\n${result.output}`,
  );
  return false;
}

function verifyEmittedConsumerDts(label, dts) {
  const trimmed = dts.trim();
  if (trimmed.length === 0) {
    console.error(`[check-declarations-strict] ${label} emitted an empty consumer .d.ts`);
    return false;
  }
  if (dts.includes('/*elided*/') || /\bany\b/.test(dts)) {
    console.error(
      `[check-declarations-strict] ${label} emitted elided or implicit any in consumer .d.ts (${Buffer.byteLength(dts, 'utf8')} bytes):\n${dts}`,
    );
    return false;
  }
  if (!dts.includes('AgentModelProviderOptions')) {
    console.error(
      `[check-declarations-strict] ${label} consumer .d.ts did not reference AgentModelProviderOptions:\n${dts}`,
    );
    return false;
  }
  return true;
}

function checkConsumerDeclarationEmit(workdir) {
  const consumerFile = join(workdir, 'consumer-emit.ts');
  writeFileSync(
    consumerFile,
    [
      'import {',
      '  type AgentModelProviderOptions,',
      '  AgentModelProviderOptionsSchema,',
      "} from 'stitchkit/agent-runtime';",
      '',
      'export function read(o: AgentModelProviderOptions) {',
      '  return o.openrouter;',
      '}',
      'export const schema = AgentModelProviderOptionsSchema;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workdir, 'tsconfig.consumer.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          target: 'ES2022',
          lib: ['ES2023', 'DOM'],
          module: 'Preserve',
          moduleResolution: 'bundler',
          declaration: true,
          emitDeclarationOnly: true,
          outDir: 'consumer-out',
          skipLibCheck: true,
          types: [],
        },
        include: ['consumer-emit.ts'],
      },
      null,
      2,
    )}\n`,
  );

  const result = runTsc(workdir, [
    '--declaration',
    '--emitDeclarationOnly',
    '-p',
    'tsconfig.consumer.json',
  ]);
  if (!result.ok) {
    console.error(
      `[check-declarations-strict] consumer declaration emit failed:\n${result.output}`,
    );
    return { ok: false, ts7Bytes: 0, ts6Bytes: 0 };
  }
  const emittedPath = join(workdir, 'consumer-out', 'consumer-emit.d.ts');
  if (!existsSync(emittedPath)) {
    console.error('[check-declarations-strict] consumer-emit.d.ts was not emitted by tsc');
    return { ok: false, ts7Bytes: 0, ts6Bytes: 0 };
  }
  const ts7Dts = readFileSync(emittedPath, 'utf8');
  if (!verifyEmittedConsumerDts('tsc', ts7Dts)) {
    return { ok: false, ts7Bytes: 0, ts6Bytes: 0 };
  }

  // Also check TypeScript 6 declaration emit in-process: TS6 elides unexported recursive
  // aliases into `/*elided*/ any` and bloats consumer `.d.ts` files.
  const ts6Program = ts.createProgram([consumerFile], {
    strict: true,
    exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    types: [],
  });
  let ts6Dts = '';
  const ts6Emit = ts6Program.emit(undefined, (fileName, text) => {
    if (fileName.endsWith('consumer-emit.d.ts')) ts6Dts = text;
  });
  const ts6Diagnostics = [...ts.getPreEmitDiagnostics(ts6Program), ...ts6Emit.diagnostics];
  if (ts6Diagnostics.length > 0) {
    const formatted = ts6Diagnostics
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    console.error(
      `[check-declarations-strict] TS6 consumer declaration emit reported diagnostics:\n${formatted}`,
    );
    return { ok: false, ts7Bytes: 0, ts6Bytes: 0 };
  }
  if (!verifyEmittedConsumerDts('TS6', ts6Dts)) {
    return { ok: false, ts7Bytes: 0, ts6Bytes: 0 };
  }

  return {
    ok: true,
    ts7Bytes: Buffer.byteLength(ts7Dts, 'utf8'),
    ts6Bytes: Buffer.byteLength(ts6Dts, 'utf8'),
  };
}

const workdir = mkdtempSync(join(tmpdir(), 'stitchkit-declarations-'));
let failed = false;
let consumerStats = { ok: false, ts7Bytes: 0, ts6Bytes: 0 };

try {
  if (!checkStrictEntrypoints(workdir)) failed = true;
  prepareConsumerNodeModules(workdir);
  if (!checkDxExactOptional(workdir)) failed = true;
  consumerStats = checkConsumerDeclarationEmit(workdir);
  if (!consumerStats.ok) failed = true;
} finally {
  if (process.env.DECLARATION_GATE_DEBUG) console.error(`[debug] workdir kept: ${workdir}`);
  else rmSync(workdir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log(
  `[check-declarations-strict] ${ENTRYPOINTS.length} entrypoints typecheck with skipLibCheck: false; DX passes --exactOptionalPropertyTypes; consumer .d.ts clean (tsc ${consumerStats.ts7Bytes}B, TS6 ${consumerStats.ts6Bytes}B)`,
);
