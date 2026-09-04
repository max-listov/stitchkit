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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ENTRYPOINTS } from '../entrypoints.mjs';

const pkgRoot = resolve(import.meta.dirname, '..');
const dist = join(pkgRoot, 'dist');
// The built entry, not its `.d.ts`. TypeScript resolves the sibling declaration
// itself, and importing a `.d.ts` by path is `TS2846` — a diagnostic about the
// probe rather than about the package.
const entryOf = (source) => join(dist, source.replace(/^src\//, '').replace(/\.tsx?$/, '.js'));

const workdir = mkdtempSync(join(tmpdir(), 'stitchkit-declarations-'));
let failed = false;

try {
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

  let output = '';
  let ran = false;
  try {
    execFileSync('bunx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
      cwd: workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ran = true;
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // A compiler that reported diagnostics ran. One that was killed or missing
    // did not, and "no output" from it must never read as "clean" — the consumer
    // lane learned that the expensive way.
    ran = typeof error.status === 'number' && output.trim().length > 0;
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
  }

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
  if (ours.length > 0) {
    failed = true;
    console.error(
      `[check-declarations-strict] ${ours.length} diagnostic(s) a strict consumer would read:`,
    );
    for (const line of ours) {
      const at = line.indexOf('(');
      console.error(
        `  dist/${resolve(workdir, line.slice(0, at)).slice(dist.length + 1)}${line.slice(at)}`,
      );
    }
  }
} finally {
  if (process.env.DECLARATION_GATE_DEBUG) console.error(`[debug] workdir kept: ${workdir}`);
  else rmSync(workdir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log(
  `[check-declarations-strict] ${ENTRYPOINTS.length} entrypoints typecheck with skipLibCheck: false`,
);
