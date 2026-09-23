/**
 * Generate the consumer-agent entry points that ship in the npm package:
 *
 *   packages/core/llms.txt       — the index (llmstxt.org): which slice to load
 *                                  for which import, with sizes, plus GitHub links.
 *   packages/core/llms/*.txt     — the slices. One per entrypoint (its guides and
 *                                  its API reference section) and one per range
 *                                  of `upgrading.md`; each at most SLICE_LIMIT_BYTES,
 *                                  a longer one continues in numbered parts.
 *   packages/core/llms-full.txt  — everything inlined, for tools that index a
 *                                  single file. Far larger than an agent's
 *                                  context: nothing tells an agent to read it whole.
 *
 * Why slices: the whole guide is ~900 KB. An agent told to read it reads a
 * random part of it instead. An agent that imports `stitchkit/server` needs
 * the server guides and the server reference, and nothing else.
 *
 * Single source of truth is `docs/guide` + `docs/api` — edit the docs, then
 * `bun run gen:llms` (the build runs it). Path-independent of cwd.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const GUIDE_DIR = join(ROOT, 'docs/guide');
const API_FILE = join(ROOT, 'docs/api/reference.md');
const OUT_DIR = join(ROOT, 'packages/core');
const PACKAGE_JSON = join(OUT_DIR, 'package.json');
const SLICE_DIR = 'llms';
const REPO = 'https://github.com/max-listov/stitchkit/blob/master';

/** The hard ceiling for one slice file, in bytes. */
export const SLICE_LIMIT_BYTES = 50 * 1024;
/** Room kept for a part's header (title, contents, next-part pointer). */
const HEADER_RESERVE_BYTES = 3 * 1024;

/** Reading order + one-line descriptions for the index. */
const GUIDE: Array<[file: string, title: string, desc: string]> = [
  [
    'getting-started.md',
    'Getting started',
    'install, entrypoints, and a first contract → server → client app',
  ],
  [
    'release.md',
    'Release',
    'stitchkit/release — the page reloads onto the release it was built for: build marker, X-Build-Id header, socket event, reload policy, the deploy signal',
  ],
  [
    'tracking.md',
    'Visitor tracking',
    'stitchkit/tracking — the browser client, outbox, page-leave beacon, attribution; stitchkit/tracking/server — dispositions and the visit lease over your store',
  ],
  [
    'contracts.md',
    'Contracts',
    'every endpoint field — method, path, params/input/output, scope, expose, meta, multipart',
  ],
  [
    'server.md',
    'HTTP server',
    'createServer/createHandler, implement, lifecycle hooks, raw routes + raw-response endpoints + helpers, scopePrefixes, serveFile, primitives',
  ],
  [
    'client.md',
    'Typed client',
    'createClient/createHttpClient, the typed call surface, scoped clients, SSE',
  ],
  [
    'mcp-and-agents.md',
    'MCP & agents',
    'contracts as MCP tools (createMcpHandler) and AI-agent tools (mountAgent); tool lifecycle, extend, identity, a separate tool answer (withToolView)',
  ],
  [
    'agent-runtime.md',
    'Agent application runtime',
    'optional durable history, prompt/model composition, stream loop, coordination, fencing and events',
  ],
  [
    'application-kernel.md',
    'Managed application kernel',
    'process-local resources, readiness, admission, schedules, projections and optional provider adapters',
  ],
  [
    'sandbox.md',
    'Optional process sandbox',
    'Linux Bubblewrap sessions, durable workspace reconnect, network policy and host credential brokering',
  ],
  [
    'primitives.md',
    'Generic application primitives',
    'lifecycle transitions, owner scope, permissions, exact money and quantities, deadlines, audit, delivery and exports — declared, not persisted',
  ],
  [
    'application-migration-recipes.md',
    'Application migration recipes',
    'executable database, poller, queue-consumer and operational publishing cutovers',
  ],
  ['cli.md', 'CLI', 'contracts as a command-line program'],
  [
    'realtime.md',
    'Realtime',
    'Socket.IO server/client wrappers, handshake auth, the cache bridge, a raw WebSocket lane',
  ],
  [
    'live.md',
    'Live data',
    'defineEvents beside the contract, watched reads shared by every subscriber, keyspaces with authoritative memory, and the trust fence',
  ],
  [
    'auth-and-errors.md',
    'Auth & errors',
    'scopes, createAuthHook, JWT/cookies, the AppError model, the stitch error-code registry',
  ],
  [
    'oauth.md',
    'OAuth & OpenID Connect',
    'browser Authorization Code + PKCE transactions and the optional Google OIDC server adapter',
  ],
  [
    'observability.md',
    'Observability',
    'request and tool-call observability, W3C trace context, createObservability',
  ],
  [
    'testing-and-deployment.md',
    'Testing & deployment',
    'in-process testing; deploying on Bun and on Node (serveNode)',
  ],
  [
    'multi-tenant.md',
    'Multi-tenant',
    'a /tenants/:id/… scenario end-to-end — scopePrefixes, scoped client, extend',
  ],
  [
    'frontend-integrations.md',
    'Frontend integrations',
    'React Router resource routes and a separate Vite development proxy',
  ],
  [
    'react.md',
    'React Query policy',
    'request-local SSR clients, a browser singleton and ApiError retry rules',
  ],
  [
    'voice.md',
    'Voice',
    'stitchkit/voice — sentences cut while a reply streams, the text a voice reads, a speech queue that synthesises ahead and stops on interruption',
  ],
  [
    'geo.md',
    'GeoIP',
    'stitchkit/geo — a server-only managed reader, three observable states and last-known-good generation reloads',
  ],
  [
    'upgrading.md',
    'Upgrading',
    'moving a project across stitchkit versions; how breaking changes are marked',
  ],
  [
    'declaration.md',
    'Project declaration',
    'the optional machine-readable statement a repository makes about itself — identity, roles, build, requirements, release steps and the names of the values a deployment supplies',
  ],
];
const API: [file: string, title: string, desc: string] = [
  'reference.md',
  'API reference',
  'every public export, grouped by entrypoint, each linked to the guide',
];

/** The slice kind for `upgrading.md`: split by version range, not by entrypoint. */
const UPGRADING = 'upgrading';

/** Where a guide lives: its body in exactly one slice, a pointer in the others. */
export interface GuideHome {
  /** The one entrypoint whose slice carries the guide's body. */
  readonly primary: string;
  /** Entrypoints whose slices carry a one-line pointer to the primary slice. */
  readonly also?: readonly string[];
}
export type GuideMap = Record<string, GuideHome | typeof UPGRADING>;

/**
 * Guide → its home. Every guide page lands in exactly one slice, so nothing is
 * duplicated across slices; `checkGuideMap` refuses a page that lands nowhere
 * and a target that is not a published entrypoint.
 */
export const GUIDE_SLICES: GuideMap = {
  'getting-started.md': { primary: '.' },
  'release.md': { primary: './release' },
  'tracking.md': { primary: './tracking', also: ['./tracking/server'] },
  'contracts.md': { primary: './contract', also: ['.'] },
  'server.md': { primary: './server', also: ['./node'] },
  'client.md': { primary: '.' },
  'mcp-and-agents.md': {
    primary: './tools',
    also: ['./tools/contract', './tools/invoker', './tools/connections', './remote'],
  },
  'agent-runtime.md': {
    primary: './agent-runtime',
    also: [
      './agent-runtime/testing',
      './agent-runtime/harness',
      './agent-runtime/coding-tools',
      './agent-runtime/browser',
      './agent-runtime/openrouter',
      './agent-runtime/sqlite/bun',
      './agent-runtime/sqlite/node',
      './agent-runtime/sandbox',
    ],
  },
  'application-kernel.md': {
    primary: './application',
    also: [
      './application/grammy',
      './application/opentelemetry',
      './application/diagnostic-journal',
      './application/directory-inbox',
      './application/schemas',
    ],
  },
  'sandbox.md': { primary: './agent-runtime/sandbox' },
  'primitives.md': { primary: './primitives' },
  'application-migration-recipes.md': { primary: './application' },
  'cli.md': { primary: './cli' },
  'realtime.md': { primary: './server', also: ['.', './react', './node'] },
  'live.md': { primary: './live' },
  'auth-and-errors.md': { primary: './server', also: ['./node', './contract', '.'] },
  'oauth.md': { primary: './oauth', also: ['./google'] },
  'observability.md': { primary: './observability' },
  'testing-and-deployment.md': { primary: './testing', also: ['./server', './node'] },
  'multi-tenant.md': { primary: './server' },
  'frontend-integrations.md': { primary: './react' },
  'react.md': { primary: './react' },
  'geo.md': { primary: './geo' },
  'voice.md': { primary: './voice' },
  'upgrading.md': UPGRADING,
  'declaration.md': { primary: './declaration' },
};

/** Reference sections for a package other than `stitchkit`, filed under the entrypoint they extend. */
const API_SECTION_HOME: Record<string, string> = { 'stitchkit-tui': './agent-runtime' };

/** Problems with the guide map; empty when every page lands in exactly one slice. */
export function checkGuideMap(
  onDisk: readonly string[],
  map: GuideMap,
  entrypoints: readonly string[],
): string[] {
  const known = new Set(entrypoints);
  const problems: string[] = [];
  for (const file of onDisk) {
    const home = map[file];
    if (home === undefined) {
      problems.push(`${file} lands in no slice (add it to GUIDE_SLICES)`);
      continue;
    }
    if (home === UPGRADING) continue;
    for (const entry of [home.primary, ...(home.also ?? [])]) {
      if (!known.has(entry)) problems.push(`${file} → ${entry} is not a package export`);
    }
    if (home.also?.includes(home.primary)) {
      problems.push(`${file} points its primary slice ${home.primary} at itself`);
    }
  }
  for (const file of Object.keys(map)) {
    if (!onDisk.includes(file)) problems.push(`${file} is mapped but not on disk`);
  }
  return problems;
}

/** Throws when a guide or reference body sits in more than one slice. */
export function assertNoDuplicateBodies(
  slices: readonly {
    readonly file: string;
    readonly topic: string;
    readonly sources: readonly string[];
  }[],
): void {
  const homes = new Map<string, Set<string>>();
  for (const slice of slices) {
    for (const source of slice.sources) {
      homes.set(source, (homes.get(source) ?? new Set()).add(slice.topic));
    }
  }
  const duplicated = [...homes].filter(([, topics]) => topics.size > 1);
  if (duplicated.length > 0) {
    throw new Error(
      `[gen:llms] bodies in more than one slice: ${duplicated.map(([s, t]) => `${s} in ${[...t].join(', ')}`).join('; ')}`,
    );
  }
}

/** Throws when a slice is over the limit — the one guarantee the slices exist for. */
export function assertSliceSizes(
  slices: readonly { readonly file: string; readonly bytes: number }[],
  limit: number = SLICE_LIMIT_BYTES,
): void {
  const over = slices.filter((slice) => slice.bytes > limit);
  if (over.length > 0) {
    throw new Error(
      `[gen:llms] slices over ${limit} bytes: ${over.map((s) => `${s.file} (${s.bytes})`).join(', ')}`,
    );
  }
}

// ── markdown splitting (fence-aware) ──────────────────────────────────────

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');
const FENCE = /^\s*(```|~~~)/;

/** Split at headings of exactly `level`, ignoring `#` lines inside code fences. */
function sectionsAt(markdown: string, level: number): string[] {
  const heading = new RegExp(`^#{${level}} `);
  const sections: string[][] = [[]];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && heading.test(line)) sections.push([]);
    sections[sections.length - 1]?.push(line);
  }
  return sections.map((lines) => lines.join('\n').trim()).filter((s) => s.length > 0);
}

/** Paragraphs separated by blank lines outside code fences. */
function paragraphsOf(markdown: string): string[] {
  const paragraphs: string[][] = [[]];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === '') paragraphs.push([]);
    else paragraphs[paragraphs.length - 1]?.push(line);
  }
  return paragraphs.map((lines) => lines.join('\n')).filter((p) => p.trim().length > 0);
}

function packPieces(pieces: readonly string[], max: number, joiner: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const next = current === '' ? piece : `${current}${joiner}${piece}`;
    if (bytesOf(next) <= max) current = next;
    else {
      if (current !== '') out.push(current);
      current = piece;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** Break `text` into pieces of at most `max` bytes at the coarsest boundary that fits. */
export function splitToFit(text: string, max: number): string[] {
  if (bytesOf(text) <= max) return [text];
  for (const level of [2, 3, 4]) {
    const sections = sectionsAt(text, level);
    if (sections.length > 1) return sections.flatMap((section) => splitToFit(section, max));
  }
  const paragraphs = paragraphsOf(text);
  if (paragraphs.length > 1) {
    return packPieces(
      paragraphs.flatMap((p) => splitToFit(p, max)),
      max,
      '\n\n',
    );
  }
  const lines = text.split('\n');
  const tooLong = lines.find((line) => bytesOf(line) > max);
  if (tooLong !== undefined) throw new Error(`[gen:llms] one line exceeds ${max} bytes`);
  return packPieces(lines, max, '\n');
}

// ── slices ─────────────────────────────────────────────────────────────────

/** A labelled run of markdown: a guide page, a reference section, a migration. */
interface Unit {
  readonly source: string;
  readonly text: string;
}

export interface Slice {
  /** Path inside the package, e.g. `llms/server.txt`. */
  readonly file: string;
  /** What the slice is about: `stitchkit/server`, `Upgrading 0.85.0 – 0.93.0`. */
  readonly topic: string;
  /** The package export it documents (`./server`), absent for upgrading slices. */
  readonly entrypoint?: string;
  readonly part: number;
  readonly parts: number;
  /** The guide pages and reference sections whose text this part carries. */
  readonly sources: readonly string[];
  readonly content: string;
  readonly bytes: number;
}

const RULE = '='.repeat(78);
const banner = (source: string, continued: boolean): string =>
  `${RULE}\n# ${source}${continued ? '  (continued)' : ''}\n${RULE}`;

/** Pack units into bodies of at most `budget` bytes, re-bannering a source cut across parts. */
function packUnits(
  units: readonly Unit[],
  budget: number,
): { body: string; sources: string[] }[] {
  const pieces = units.flatMap((unit) =>
    splitToFit(unit.text, budget - bytesOf(banner(unit.source, true)) - 4).map((text) => ({
      source: unit.source,
      text,
    })),
  );
  const parts: { body: string; sources: string[] }[] = [];
  let body = '';
  let sources: string[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    const last = sources[sources.length - 1];
    const head =
      last === piece.source ? '' : `${banner(piece.source, seen.has(piece.source))}\n\n`;
    const chunk = `${head}${piece.text}`;
    const next = body === '' ? chunk : `${body}\n\n${chunk}`;
    if (bytesOf(next) <= budget || body === '') {
      body = next;
      if (last !== piece.source) sources.push(piece.source);
    } else {
      parts.push({ body, sources });
      body = `${banner(piece.source, seen.has(piece.source))}\n\n${piece.text}`;
      sources = [piece.source];
    }
    seen.add(piece.source);
  }
  if (body !== '') parts.push({ body, sources });
  return parts;
}

const partFile = (slug: string, part: number): string =>
  `${SLICE_DIR}/${slug}${part === 1 ? '' : `.${part}`}.txt`;

function toSlices(
  slug: string,
  topic: string,
  units: readonly Unit[],
  entrypoint?: string,
  pointers: readonly string[] = [],
): Slice[] {
  const packed = packUnits(units, SLICE_LIMIT_BYTES - HEADER_RESERVE_BYTES);
  // A slice made only of pointers still exists: the agent that imports it finds where to read.
  if (packed.length === 0) packed.push({ body: '', sources: [] });
  const parts = packed.length;
  // Every part carries the map of all parts, so an agent can load only the one it needs.
  const contents =
    parts === 1
      ? `Contains: ${packed[0]?.sources.join(' · ') || 'pointers only'}`
      : [
          'Parts of this slice:',
          ...packed.map((p, i) => `- \`${partFile(slug, i + 1)}\`: ${p.sources.join(' · ')}`),
        ].join('\n');
  const seeAlso = pointers.length === 0 ? null : ['Also read:', ...pointers].join('\n');
  return packed.map(({ body, sources }, index) => {
    const part = index + 1;
    const header = [
      `# ${topic} — stitchkit docs slice${parts > 1 ? `, part ${part} of ${parts}` : ''}`,
      '',
      '> Generated from the `docs/` tree by `bun run gen:llms`. The index of all slices is',
      '> `llms.txt` in this package.',
      part < parts ? `> Continues in \`${partFile(slug, part + 1)}\`.` : null,
      '',
      contents,
      seeAlso === null ? null : '',
      seeAlso,
    ].filter((line): line is string => line !== null);
    const content =
      body === '' ? `${header.join('\n')}\n` : `${header.join('\n')}\n\n${body}\n`;
    return {
      file: partFile(slug, part),
      topic,
      ...(entrypoint === undefined ? {} : { entrypoint }),
      part,
      parts,
      sources,
      content,
      bytes: bytesOf(content),
    };
  });
}

export const entrypointName = (subpath: string): string =>
  subpath === '.' ? 'stitchkit' : `stitchkit/${subpath.slice(2)}`;
const entrypointSlug = (subpath: string): string =>
  subpath === '.' ? 'stitchkit' : subpath.slice(2).replaceAll('/', '-');

/** The reference split by `## \`entrypoint\`` section, keyed by package subpath. */
function referenceByEntrypoint(
  reference: string,
  known: ReadonlySet<string>,
): Map<string, Unit[]> {
  const byEntry = new Map<string, Unit[]>();
  for (const section of sectionsAt(reference, 2).slice(1)) {
    const name = /^## `([^`]+)`/.exec(section)?.[1];
    if (name === undefined)
      throw new Error('[gen:llms] reference section without an entrypoint');
    const subpath =
      API_SECTION_HOME[name] ??
      (name === 'stitchkit' ? '.' : `./${name.replace(/^stitchkit\//, '')}`);
    if (!known.has(subpath)) {
      throw new Error(`[gen:llms] reference section \`${name}\` is not a package export`);
    }
    const units = byEntry.get(subpath) ?? [];
    units.push({ source: `API reference: \`${name}\`  (docs/api/${API[0]})`, text: section });
    byEntry.set(subpath, units);
  }
  return byEntry;
}

const versionKey = (version: string): number[] => version.split('.').map(Number);
const compareVersions = (a: string, b: string): number => {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** The version an upgrading section belongs to, or null for general guidance. */
function sectionVersion(section: string): string | null {
  const title = section.split('\n', 1)[0] ?? '';
  const match =
    /^## Released migration: (\d+\.\d+\.\d+)/.exec(title) ??
    /^## Historical breaking migrations through (\d+\.\d+\.\d+)/.exec(title) ??
    /^## The (\d+\.\d+) migration/.exec(title);
  if (match?.[1] === undefined) return null;
  return match[1].split('.').length === 2 ? `${match[1]}.0` : match[1];
}

/** `upgrading.md` → one general slice plus slices by contiguous version range. */
function upgradingSlices(markdown: string): Slice[] {
  const source = (range: string): string =>
    `Guide: Upgrading, ${range}  (docs/guide/upgrading.md)`;
  const general: string[] = [];
  const versioned: { version: string; text: string }[] = [];
  for (const section of sectionsAt(markdown, 2)) {
    const version = sectionVersion(section);
    if (version === null) general.push(section);
    else versioned.push({ version, text: section });
  }
  versioned.sort((a, b) => compareVersions(b.version, a.version));

  const budget = SLICE_LIMIT_BYTES - HEADER_RESERVE_BYTES - 512;
  const ranges: { newest: string; oldest: string; texts: string[] }[] = [];
  for (const { version, text } of versioned) {
    const current = ranges[ranges.length - 1];
    if (current !== undefined && bytesOf([...current.texts, text].join('\n\n')) <= budget) {
      current.texts.push(text);
      current.oldest = version;
    } else ranges.push({ newest: version, oldest: version, texts: [text] });
  }
  const rangeSlices = ranges.flatMap(({ newest, oldest, texts }) => {
    const label = newest === oldest ? newest : `${oldest}-${newest}`;
    return toSlices(`upgrading-${label}`, `Upgrading ${oldest} → ${newest}`, [
      { source: source(`${oldest} → ${newest}`), text: texts.join('\n\n') },
    ]);
  });
  const rangeList = ranges
    .map(({ newest, oldest }) => {
      const label = newest === oldest ? newest : `${oldest}-${newest}`;
      return `- ${oldest} → ${newest}: \`${partFile(`upgrading-${label}`, 1)}\``;
    })
    .join('\n');
  const intro = `Load this slice, then every range slice between your installed version and the target:\n\n${rangeList}`;
  const generalSlices = toSlices('upgrading', 'Upgrading — how to move across versions', [
    { source: source('general'), text: [intro, ...general].join('\n\n') },
  ]);
  return [...generalSlices, ...rangeSlices];
}

/** Every slice, built from the docs on disk. Throws on an unmapped guide or an oversized slice. */
export function buildSlices(): Slice[] {
  const entrypoints = packageExports();
  const onDisk = readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'));
  const problems = checkGuideMap(onDisk, GUIDE_SLICES, entrypoints);
  // Reading order and titles live in GUIDE; a page missing there has no title.
  const listed = new Set(GUIDE.map(([file]) => file));
  for (const file of onDisk.filter((f) => !listed.has(f))) {
    problems.push(`${file} is missing from GUIDE (reading order + title)`);
  }
  if (problems.length > 0) throw new Error(`[gen:llms] guide map: ${problems.join('; ')}`);

  const reference = referenceByEntrypoint(
    readFileSync(API_FILE, 'utf8'),
    new Set(entrypoints),
  );
  const slices: Slice[] = [];
  for (const subpath of entrypoints) {
    const units: Unit[] = [];
    const pointers: string[] = [];
    for (const [file, title] of GUIDE) {
      const home = GUIDE_SLICES[file];
      if (home === undefined || home === UPGRADING) continue;
      if (home.primary === subpath) {
        units.push({
          source: `Guide: ${title}  (docs/guide/${file})`,
          text: readFileSync(join(GUIDE_DIR, file), 'utf8').trim(),
        });
      } else if (home.also?.includes(subpath)) {
        const target = partFile(entrypointSlug(home.primary), 1);
        pointers.push(`- see \`${target}\` for the ${title} guide`);
      }
    }
    units.push(...(reference.get(subpath) ?? []));
    if (units.length === 0 && pointers.length === 0) {
      throw new Error(`[gen:llms] ${subpath} has nothing to put in a slice`);
    }
    const slug = entrypointSlug(subpath);
    slices.push(...toSlices(slug, entrypointName(subpath), units, subpath, pointers));
  }
  slices.push(...upgradingSlices(readFileSync(join(GUIDE_DIR, 'upgrading.md'), 'utf8')));
  assertSliceSizes(slices);
  assertNoDuplicateBodies(slices);
  return slices;
}

/** The subpaths of `packages/core/package.json#exports`, in declaration order. */
export function packageExports(): string[] {
  const manifest: { exports: Record<string, unknown> } = JSON.parse(
    readFileSync(PACKAGE_JSON, 'utf8'),
  );
  return Object.keys(manifest.exports).filter((key) => key !== './package.json');
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

function sliceLinks(slices: readonly Slice[]): string {
  const [first] = slices;
  if (first === undefined) return '';
  const files = slices.map((s) => `[${s.file}](${s.file}) ${kb(s.bytes)}`).join(' → ');
  return `- **${first.topic}**: ${files}`;
}

function groupByTopic(slices: readonly Slice[]): Slice[][] {
  const groups = new Map<string, Slice[]>();
  for (const slice of slices)
    groups.set(slice.topic, [...(groups.get(slice.topic) ?? []), slice]);
  return [...groups.values()];
}

function renderIndex(slices: readonly Slice[]): string {
  const byEntry = groupByTopic(slices.filter((s) => s.entrypoint !== undefined));
  const upgrading = groupByTopic(slices.filter((s) => s.entrypoint === undefined));
  const limit = kb(SLICE_LIMIT_BYTES);
  return [
    '# stitchkit',
    '',
    '> Contract-first backend framework for Bun and Node. One `defineContract()` becomes an HTTP API, MCP tools, AI-agent tools, a CLI and a fully-typed client — one source of truth, no drift.',
    '',
    'Build with stitchkit: define a contract once, then `implement` it and serve it (`createServer` on Bun, `serveNode` on Node ≥ 22). The same contract drives MCP / agent tools and a typed client, so the transports cannot diverge.',
    '',
    '## How to read these docs',
    '',
    `Load the slice for each entrypoint your code imports — \`import … from 'stitchkit/server'\` → \`llms/server.txt\`; the root \`stitchkit\` import → \`llms/stitchkit.txt\`. A slice holds that entrypoint's API reference section and the guide pages whose home it is; every guide lives in exactly one slice, and a slice that needs another's guide names it under "Also read". Each file is at most ${limit}; a longer one continues in numbered parts, each naming the next at its top. Moving across versions: load \`llms/upgrading.txt\` and the range slices it lists between your version and the target. \`llms-full.txt\` inlines everything; it is far larger than a context window, so do not read it whole.`,
    '',
    '## Entrypoint slices',
    ...byEntry.map(sliceLinks),
    '',
    '## Upgrading slices',
    ...upgrading.map(sliceLinks),
    '',
    '## Guide (web)',
    ...GUIDE.map(([file, title, desc]) => `- [${title}](${REPO}/docs/guide/${file}): ${desc}`),
    '',
    '## Reference (web)',
    `- [${API[1]}](${REPO}/docs/api/${API[0]}): ${API[2]}`,
    '',
  ].join('\n');
}

function renderFull(): string {
  const full = [
    '# stitchkit — full documentation',
    '',
    '> The complete guide + API reference, inlined for tools that index one file. Far',
    '> larger than an agent context — an agent loads the slices listed in `llms.txt`.',
    '> Generated from the `docs/` tree (the source of truth) by `bun run gen:llms`.',
  ];
  for (const [file, title] of GUIDE) {
    full.push('', '', RULE, `# Guide: ${title}  (docs/guide/${file})`, RULE, '');
    full.push(readFileSync(join(GUIDE_DIR, file), 'utf8').trim());
  }
  full.push('', '', RULE, `# ${API[1]}  (docs/api/${API[0]})`, RULE, '');
  full.push(readFileSync(API_FILE, 'utf8').trim());
  return `${full.join('\n')}\n`;
}

function main(): void {
  let slices: Slice[];
  try {
    slices = buildSlices();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const sliceDir = join(OUT_DIR, SLICE_DIR);
  rmSync(sliceDir, { recursive: true, force: true });
  mkdirSync(sliceDir, { recursive: true });
  for (const slice of slices) writeFileSync(join(OUT_DIR, slice.file), slice.content);
  writeFileSync(join(OUT_DIR, 'llms.txt'), renderIndex(slices));
  writeFileSync(join(OUT_DIR, 'llms-full.txt'), renderFull());
  const largest = slices.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  console.log(
    `gen:llms → packages/core/llms.txt + ${slices.length} slices in llms/ (largest ${largest.file} ${kb(largest.bytes)}) + llms-full.txt`,
  );
}

if (import.meta.main) main();
