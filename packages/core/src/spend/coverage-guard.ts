import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { type CoverageToken, tokenize } from './coverage-lexer';

/**
 * What only the gateway files may touch. `modules` — SDK packages (with `symbols`,
 * only those value imports count: `ai` with `streamText`, `generateText`, …);
 * `envKeys` — provider credential names; `hosts` — provider hostnames. Every
 * allowance names its file and why; an allowance that no longer covers anything
 * is itself a finding.
 */
export const SpendCoveragePolicySchema = z.strictObject({
  modules: z.array(
    z.strictObject({
      module: z.string().min(1),
      symbols: z.array(z.string().min(1)).min(1).optional(),
    }),
  ),
  envKeys: z.array(z.string().min(1)).default([]),
  hosts: z.array(z.string().min(1)).default([]),
  allowedFiles: z
    .array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1) }))
    .default([]),
});
/** What only the gateway files may touch: SDK modules, key names, hosts, and the allowances. */
export type SpendCoveragePolicy = z.input<typeof SpendCoveragePolicySchema>;

/** One place a model call, key or host bypasses the gateway. */
export interface SpendCoverageFinding {
  /** Relative to the scanned root, `/`-separated. */
  file: string;
  line: number;
  kind: 'module' | 'env-key' | 'host';
  detail: string;
}

/** What a coverage scan saw: files scanned, findings, allowances nothing needs. */
export interface SpendCoverageReport {
  scannedFiles: number;
  findings: SpendCoverageFinding[];
  /** Allowances whose file is gone or no longer touches anything the policy names. */
  staleAllowances: { path: string; reason: string }[];
}

type Policy = z.output<typeof SpendCoveragePolicySchema>;

function isReexportStart(tokens: readonly CoverageToken[], afterExport: number): boolean {
  const first = tokens[afterExport];
  const target =
    first?.kind === 'word' && first.text === 'type' ? tokens[afterExport + 1] : first;
  return target?.text === '{' || target?.text === '*';
}

function moduleSpecifierAfter(
  tokens: readonly CoverageToken[],
  from: number,
): { target: CoverageToken; index: number; fromAt: number } | undefined {
  const first = tokens[from];
  if (first?.kind === 'string') return { target: first, index: from, fromAt: from };
  let braceDepth = 0;
  for (let i = from; i < tokens.length && i < from + 512; i += 1) {
    const token = tokens[i];
    if (!token) break;
    if (token.text === '{') {
      braceDepth += 1;
    } else if (token.text === '}') {
      if (braceDepth === 0) return undefined;
      braceDepth -= 1;
      if (braceDepth === 0) {
        const afterBrace = tokens[i + 1];
        const target = tokens[i + 2];
        if (
          afterBrace?.kind === 'word' &&
          afterBrace.text === 'from' &&
          target?.kind === 'string'
        )
          return { target, index: i + 2, fromAt: i + 1 };
        return undefined;
      }
    } else if (braceDepth === 0) {
      if (
        token.text === ';' ||
        (token.kind === 'word' && (token.text === 'import' || token.text === 'export'))
      )
        return undefined;
      if (token.kind === 'word' && token.text === 'from') {
        const target = tokens[i + 1];
        if (target?.kind === 'string') return { target, index: i + 1, fromAt: i };
      }
    }
  }
  return undefined;
}

function isClauseTypeModifier(
  tokens: readonly CoverageToken[],
  start: number,
  end: number,
): boolean {
  const first = tokens[start];
  return (
    first?.kind === 'word' &&
    first.text === 'type' &&
    end > start + 1 &&
    tokens[start + 1]?.text !== ','
  );
}

function isNameToken(token: CoverageToken | undefined): token is CoverageToken {
  return token !== undefined && (token.kind === 'word' || token.kind === 'string');
}

function isInlineTypeModifier(tokens: readonly CoverageToken[], index: number): boolean {
  const next = tokens[index + 1];
  if (!isNameToken(next)) return false;
  if (next.kind === 'word' && next.text === 'as') {
    const afterAs = tokens[index + 2];
    if (!isNameToken(afterAs)) return true;
    return afterAs.kind === 'word' && afterAs.text === 'as' && isNameToken(tokens[index + 3]);
  }
  return true;
}

/**
 * The value bindings of one `import`/`export … from` clause: `undefined` for a
 * clause that binds the whole module (default, namespace, side effect, `export *`),
 * otherwise the named value specifiers (type-only ones dropped).
 */
function clauseBindings(
  tokens: readonly CoverageToken[],
  start: number,
  end: number,
): { whole: boolean; named: string[]; typeOnly: boolean } {
  if (isClauseTypeModifier(tokens, start, end))
    return { whole: false, named: [], typeOnly: true };
  let whole = start === end;
  const named: string[] = [];
  let inBraces = false;
  let expectName = true;
  let skipType = false;
  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.text === '{') {
      inBraces = true;
      expectName = true;
      skipType = false;
    } else if (token.text === '}') {
      inBraces = false;
      expectName = true;
      skipType = false;
    } else if (token.text === '*') {
      whole = true;
    } else if (inBraces && token.text === ',') {
      expectName = true;
      skipType = false;
    } else if (inBraces && isNameToken(token)) {
      if (expectName) {
        if (
          !skipType &&
          token.kind === 'word' &&
          token.text === 'type' &&
          isInlineTypeModifier(tokens, i)
        ) {
          skipType = true;
        } else {
          if (!skipType) named.push(token.text);
          expectName = false;
          skipType = false;
        }
      } else if (token.kind === 'word' && token.text === 'as' && isNameToken(tokens[i + 1])) {
        i += 1;
      }
    } else if (!inBraces && token.kind === 'word' && token.text !== 'as') {
      whole = true;
    }
  }
  return { whole, named, typeOnly: !whole && named.length === 0 && end > start };
}

/** `openai` covers `openai/…`; `@scope/*` covers every package of the scope. */
function moduleMatches(rule: string, module: string): boolean {
  if (rule.endsWith('/*')) return module.startsWith(rule.slice(0, -1));
  return module === rule || module.startsWith(`${rule}/`);
}

function moduleFinding(
  policy: Policy,
  module: string,
  bindings: { whole: boolean; named: string[]; typeOnly: boolean },
): string | undefined {
  const rule = policy.modules.find((entry) => moduleMatches(entry.module, module));
  if (!rule || bindings.typeOnly) return undefined;
  if (!rule.symbols) return `imports ${module}`;
  if (bindings.whole) return `imports all of ${module}`;
  const hit = bindings.named.filter((name) => rule.symbols?.includes(name));
  return hit.length > 0 ? `imports ${hit.join(', ')} from ${module}` : undefined;
}

/** Findings in one source text; `file` only labels them. */
export function scanSpendCoverageSource(
  file: string,
  source: string,
  rawPolicy: SpendCoveragePolicy,
): SpendCoverageFinding[] {
  const policy = SpendCoveragePolicySchema.parse(rawPolicy);
  const tokens = tokenize(source);
  const findings: SpendCoverageFinding[] = [];
  const add = (kind: SpendCoverageFinding['kind'], line: number, detail: string) =>
    findings.push({ file, line, kind, detail });
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const next = tokens[i + 1];
    if (
      token.kind === 'word' &&
      (token.text === 'import' || token.text === 'require') &&
      next?.text === '('
    ) {
      const target = tokens[i + 2];
      if (target?.kind === 'string') {
        const detail = moduleFinding(policy, target.text, {
          whole: true,
          named: [],
          typeOnly: false,
        });
        if (detail) add('module', token.line, `${detail} dynamically`);
      }
    } else if (
      token.kind === 'word' &&
      (token.text === 'import' ||
        (token.text === 'export' && isReexportStart(tokens, i + 1))) &&
      tokens[i - 1]?.text !== '.' &&
      next?.text !== '.'
    ) {
      const spec = moduleSpecifierAfter(tokens, i + 1);
      if (spec) {
        const detail = moduleFinding(
          policy,
          spec.target.text,
          clauseBindings(tokens, i + 1, spec.fromAt),
        );
        if (detail) add('module', token.line, detail);
      }
    }
    if (
      (token.kind === 'word' || token.kind === 'string') &&
      policy.envKeys.includes(token.text)
    )
      add('env-key', token.line, `names ${token.text}`);
    if (token.kind === 'string')
      for (const host of policy.hosts)
        if (token.text.includes(host)) add('host', token.line, `names ${host}`);
  }
  return findings;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
/** Never source, at any depth. */
const SKIPPED = new Set(['node_modules', '.git']);
/** Build output, skipped only where build output lives: at the scanned root. */
const SKIPPED_AT_ROOT = new Set(['dist', 'build', 'coverage']);

/** A linked file that resolves; a dangling link is not source and does not stop the scan. */
async function linkedFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sourceFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    if (directory === root && SKIPPED_AT_ROOT.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const source = SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts');
    if (entry.isDirectory()) files.push(...(await sourceFiles(root, path)));
    // A linked file is code the project ships too; a linked directory is not followed (no cycles).
    else if (
      source &&
      (entry.isFile() || (entry.isSymbolicLink() && (await linkedFile(path))))
    )
      files.push(relative(root, path).split(sep).join('/'));
  }
  return files.sort();
}

/** Scan every source file under `root` (skipping `node_modules`, `dist`, `.d.ts`). */
export async function checkSpendCoverage(options: {
  root: string;
  policy: SpendCoveragePolicy;
  include?: (file: string) => boolean;
}): Promise<SpendCoverageReport> {
  const policy = SpendCoveragePolicySchema.parse(options.policy);
  const allowed = new Map(policy.allowedFiles.map((entry) => [entry.path, entry]));
  const used = new Set<string>();
  const findings: SpendCoverageFinding[] = [];
  const files = (await sourceFiles(options.root)).filter(options.include ?? (() => true));
  for (const file of files) {
    const found = scanSpendCoverageSource(
      file,
      await readFile(join(options.root, file), 'utf8'),
      policy,
    );
    if (allowed.has(file)) {
      if (found.length > 0) used.add(file);
      continue;
    }
    findings.push(...found);
  }
  return {
    scannedFiles: files.length,
    findings,
    staleAllowances: policy.allowedFiles.filter((entry) => !used.has(entry.path)),
  };
}

/** Thrown by {@link assertSpendCoverage}; the message lists every finding. */
export class SpendCoverageError extends Error {
  constructor(readonly report: SpendCoverageReport) {
    const lines = [
      ...(report.scannedFiles === 0
        ? ['no source file was scanned: the root or the filter is wrong']
        : []),
      ...report.findings.map((f) => `${f.file}:${f.line} ${f.kind} ${f.detail}`),
      ...report.staleAllowances.map(
        (a) => `${a.path}: allowance no longer needed (${a.reason})`,
      ),
    ];
    super(`Model calls bypass the spend gateway:\n${lines.join('\n')}`);
    this.name = 'SpendCoverageError';
  }
}

/**
 * The test a project runs: red on a model SDK call, a provider key or a provider
 * host outside the gateway files, on an allowance nothing needs, and on a scan that
 * saw no file at all (a guard that checks nothing must not pass).
 */
export async function assertSpendCoverage(
  options: Parameters<typeof checkSpendCoverage>[0],
): Promise<SpendCoverageReport> {
  const report = await checkSpendCoverage(options);
  if (
    report.scannedFiles === 0 ||
    report.findings.length > 0 ||
    report.staleAllowances.length > 0
  )
    throw new SpendCoverageError(report);
  return report;
}
