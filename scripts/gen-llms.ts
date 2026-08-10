/**
 * Generate the consumer-agent entry points that ship in the npm package:
 *
 *   packages/core/llms.txt       — a curated index (llmstxt.org) of the guide +
 *                                  reference, links to GitHub for each page.
 *   packages/core/llms-full.txt  — the whole guide + reference inlined, so an
 *                                  agent reading `node_modules/stitchkit/` has the
 *                                  full docs offline.
 *
 * Single source of truth is `docs/guide` + `docs/api` — edit the docs, then
 * `bun run gen:llms` (the build runs it). Path-independent of cwd.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const GUIDE_DIR = join(ROOT, 'docs/guide');
const API_FILE = join(ROOT, 'docs/api/reference.md');
const OUT_DIR = join(ROOT, 'packages/core');
const REPO = 'https://github.com/max-listov/stitchkit/blob/master';

/** Reading order + one-line descriptions for the index. */
const GUIDE: Array<[file: string, title: string, desc: string]> = [
  [
    'getting-started.md',
    'Getting started',
    'install, entrypoints, and a first contract → server → client app',
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
    'contracts as MCP tools (createMcpHandler) and AI-agent tools (mountAgent); tool lifecycle, extend, identity',
  ],
  ['cli.md', 'CLI', 'contracts as a command-line program'],
  [
    'realtime.md',
    'Realtime',
    'Socket.IO server/client wrappers, handshake auth, the cache bridge, a raw WebSocket lane',
  ],
  [
    'auth-and-errors.md',
    'Auth & errors',
    'scopes, createAuthHook, JWT/cookies, the AppError model, the stitch error-code registry',
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
    'upgrading.md',
    'Upgrading',
    'moving a project across stitchkit versions; how breaking changes are marked',
  ],
];
const API: [file: string, title: string, desc: string] = [
  'reference.md',
  'API reference',
  'every public export, grouped by entrypoint, each linked to the guide',
];

// Drift guard: every guide page on disk must be listed in GUIDE, or it silently
// drops out of llms.txt (invisible to a consumer's agent). Adding a page then
// forgetting to register it here fails the build instead.
const listed = new Set(GUIDE.map(([file]) => file));
const onDisk = readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'));
const unlisted = onDisk.filter((f) => !listed.has(f));
if (unlisted.length > 0) {
  console.error(
    `[gen:llms] guide pages on disk but missing from GUIDE (add them): ${unlisted.join(', ')}`,
  );
  process.exit(1);
}

const RULE = '='.repeat(78);

// ── llms.txt — the curated index ──────────────────────────────────────────
const index = [
  '# stitchkit',
  '',
  '> Contract-first backend framework for Bun and Node. One `defineContract()` becomes an HTTP API, MCP tools, AI-agent tools, a CLI and a fully-typed client — one source of truth, no drift.',
  '',
  'Build with stitchkit: define a contract once, then `implement` it and serve it (`createServer` on Bun, `serveNode` on Node ≥ 22). The same contract drives MCP / agent tools and a typed client, so the transports cannot diverge. The pages below are the full guide; `llms-full.txt` (in this package) inlines all of them for offline reading.',
  '',
  '## Guide',
  ...GUIDE.map(([file, title, desc]) => `- [${title}](${REPO}/docs/guide/${file}): ${desc}`),
  '',
  '## Reference',
  `- [${API[1]}](${REPO}/docs/api/${API[0]}): ${API[2]}`,
  '',
];
writeFileSync(join(OUT_DIR, 'llms.txt'), `${index.join('\n')}\n`);

// ── llms-full.txt — the whole guide + reference inlined ────────────────────
const full = [
  '# stitchkit — full documentation',
  '',
  '> The complete guide + API reference, inlined for offline agent use. Generated',
  '> from the `docs/` tree (the source of truth) by `bun run gen:llms`.',
];
for (const [file, title] of GUIDE) {
  full.push('', '', RULE, `# Guide: ${title}  (docs/guide/${file})`, RULE, '');
  full.push(readFileSync(join(GUIDE_DIR, file), 'utf8').trim());
}
full.push('', '', RULE, `# ${API[1]}  (docs/api/${API[0]})`, RULE, '');
full.push(readFileSync(API_FILE, 'utf8').trim());
writeFileSync(join(OUT_DIR, 'llms-full.txt'), `${full.join('\n')}\n`);

console.log(
  `gen:llms → packages/core/llms.txt + llms-full.txt (${GUIDE.length} guide pages + reference)`,
);
