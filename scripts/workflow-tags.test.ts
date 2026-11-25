/**
 * A workflow job that runs a check reading release tags checks out with them.
 *
 * `actions/checkout` clones one commit and no tags unless the job asks for history. A check that
 * compares a release with the published ones — the previous surface, the published companion
 * ranges, the starter follow-up, an unchanged package — then finds no tags and refuses, and the
 * job is red on the release it was meant to let through. Which jobs need tags is not written down
 * here: a job needs them when a script it runs reaches, through its static imports, a module that
 * calls `git tag`. The repository's way to give a job its tags is `fetch-depth: 0`, as the plan
 * job has always had.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { suites } from './test-suites';

const root = resolve(import.meta.dir, '..');
const WORKFLOWS = ['ci.yml', 'release.yml', 'ci-retry.yml', 'load.yml'];

/** A `git tag …` call in a script: the argument list starts with `'tag'`. */
const TAG_READ = /\[\s*'tag',/;

const StepSchema = z.object({
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const WorkflowSchema = z.object({
  jobs: z.record(z.string(), z.object({ steps: z.array(StepSchema).optional() })),
});
const PackageSchema = z.object({ scripts: z.record(z.string(), z.string()) });
const packageScripts = PackageSchema.parse(
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
).scripts;

function source(path: string): string | undefined {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * What of a module runs when a job reaches it: all of it when the job runs it, and without its
 * `if (import.meta.main)` block when the job only imports it.
 */
function reachedSource(path: string, entry: boolean): string {
  const text = source(path) ?? '';
  return entry ? text : (text.split(/^if \(import\.meta\.main\)/m)[0] ?? '');
}

/** The repository files a script reaches through its relative static imports, itself included. */
export function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    const text = source(path);
    if (text === undefined) continue;
    seen.add(path);
    for (const [, specifier] of text.matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) {
      if (specifier === undefined) continue;
      const target = relative(root, resolve(root, dirname(path), specifier));
      const candidates = /\.[cm]?[jt]sx?$/.test(target)
        ? [target]
        : [`${target}.ts`, `${target}/index.ts`];
      const found = candidates.find((candidate) => source(candidate) !== undefined);
      if (found !== undefined) pending.push(found);
    }
  }
  return seen;
}

/** The scripts a step's shell runs: `bun scripts/…`, package scripts it names, and the files of the test suites it names. */
export function stepEntries(run: string, depth = 0): string[] {
  const entries: string[] = [];
  for (const [, script] of run.matchAll(/\bbun (?:run )?(scripts\/[\w./-]+\.ts)/g))
    if (script !== undefined) entries.push(script);
  for (const [, name] of run.matchAll(/\bbun run ([\w:-]+)/g)) {
    const command = name === undefined ? undefined : packageScripts[name];
    if (command !== undefined && depth < 4) entries.push(...stepEntries(command, depth + 1));
  }
  for (const [, argument] of run.matchAll(/scripts\/test-suites\.ts([^\n]*)/g)) {
    const named = [...(argument ?? '').matchAll(/'([^']+)'|(\S+)/g)].map(
      ([, quoted, bare]) => quoted ?? bare ?? '',
    );
    for (const suite of suites())
      if (named.length === 0 || named.includes(suite.name))
        for (const part of suite.command)
          if (/^\.\/scripts\/.+\.test\.ts$/.test(part)) entries.push(part.slice(2));
  }
  return entries;
}

export interface TagJob {
  workflow: string;
  job: string;
  /** The tag readers the job's scripts reach. */
  readers: string[];
  hasTags: boolean;
}

/** Every job of a workflow that reaches a tag reader, and whether its checkout fetches tags. */
export function tagJobs(workflow: string, text: string): TagJob[] {
  const { jobs } = WorkflowSchema.parse(Bun.YAML.parse(text));
  return Object.entries(jobs).flatMap(([job, { steps = [] }]) => {
    const entries = new Set(steps.flatMap((step) => stepEntries(step.run ?? '')));
    const reached = new Set([...entries].flatMap((entry) => [...importClosure(entry)]));
    // A test that tags its own fixture repository reads no release tag; what it imports may.
    const readers = [...reached]
      .filter(
        (path) =>
          !path.endsWith('.test.ts') && TAG_READ.test(reachedSource(path, entries.has(path))),
      )
      .sort();
    if (readers.length === 0) return [];
    const hasTags = steps.some(
      (step) =>
        step.uses?.startsWith('actions/checkout@') === true &&
        step.with?.['fetch-depth'] === 0,
    );
    return [{ workflow, job, readers, hasTags }];
  });
}

describe('a job that reads release tags checks them out', () => {
  const found = WORKFLOWS.flatMap((workflow) =>
    tagJobs(workflow, readFileSync(join(root, '.github/workflows', workflow), 'utf8')),
  );

  test('every job whose scripts reach a tag reader checks out with fetch-depth: 0', () => {
    expect(found.filter((entry) => !entry.hasTags)).toEqual([]);
  });

  test('the jobs that need tags are the ones that judge a release against the published ones', () => {
    const jobs = found.map(({ workflow, job }) => `${workflow}:${job}`);
    // Publication validates the previous surface; the plan asks which commits are tagged; the
    // repository suite rehearses the queued notes against the previous release.
    for (const job of ['release.yml:publish', 'ci.yml:plan', 'ci.yml:repository'])
      expect(jobs).toContain(job);
    const publish = found.find((entry) => entry.job === 'publish');
    expect(publish?.readers).toContain('scripts/release-tags.ts');
  });

  test('a job without history that runs the release check is found', () => {
    const workflow = [
      'jobs:',
      '  publish:',
      '    steps:',
      '      - uses: actions/checkout@0000000000000000000000000000000000000000',
      '      - run: bun scripts/release-plan.ts release-metadata "$GITHUB_REF_NAME"',
      '  lint:',
      '    steps:',
      '      - uses: actions/checkout@0000000000000000000000000000000000000000',
      '      - run: bun run lint',
    ].join('\n');
    const jobs = tagJobs('synthetic.yml', workflow);
    expect(jobs.map(({ job, hasTags }) => ({ job, hasTags }))).toEqual([
      { job: 'publish', hasTags: false },
    ]);
    const withTags = workflow.replace(
      'actions/checkout@0000000000000000000000000000000000000000\n      - run: bun scripts/release-plan.ts',
      'actions/checkout@0000000000000000000000000000000000000000\n        with:\n          fetch-depth: 0\n      - run: bun scripts/release-plan.ts',
    );
    expect(tagJobs('synthetic.yml', withTags).map(({ hasTags }) => hasTags)).toEqual([true]);
  });
});
