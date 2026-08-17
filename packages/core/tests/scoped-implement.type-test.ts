/**
 * Compile-time contract of `createScopedImplement`.
 *
 * `bun test` does NOT pick this file up (its name carries no `.test.`
 * segment) — it is checked by `bun run check` (`tsc --noEmit`, tsconfig
 * `include: ["src", "tests"]`). So it asserts with types only; a runtime
 * `expect()` here would never execute.
 */
import { z } from 'zod';
import { createContractFactory, defineContract } from '../src/contract';
import { createScopedImplement, createScopedImplementRegistry } from '../src/server';

const implementFor = createScopedImplement<{
  public: object;
  user: { userId: string };
  admin: { userId: string; isAdmin: boolean };
}>();

const output = z.object({ ok: z.boolean() });

const posts = defineContract(
  { prefix: 'posts', scope: 'user' },
  {
    list: { method: 'GET', path: '/', desc: 'List', output },
    purge: { method: 'DELETE', path: '/all', desc: 'Purge', scope: 'admin', output },
    ping: { method: 'GET', path: '/ping', desc: 'Ping', scope: 'public', output },
  },
);

// One contract, three effective scopes → three different context types.
implementFor(posts, {
  // Group scope `user`: its declared field is typed exactly.
  list: (ctx) => {
    const userId: string = ctx.userId;
    return { ok: userId.length > 0 };
  },
  // Endpoint override `admin`: the admin-only field is typed here and only here.
  purge: (ctx) => {
    const isAdmin: boolean = ctx.isAdmin;
    return { ok: isAdmin };
  },
  ping: (ctx) => {
    // `public` declares no fields. `RuntimeContext` keeps its index signature
    // (transports write through it), so a foreign field is `unknown` rather than
    // a compile error on access — but it can no longer masquerade as a string.
    // @ts-expect-error — `ctx.userId` is `unknown` under the `public` scope.
    const userId: string = ctx.userId;
    return { ok: Boolean(userId) };
  },
});

const admin: { userId: string; isAdmin: boolean } = { userId: 'u', isAdmin: true };
// The admin field is NOT typed on a `user`-scoped endpoint.
implementFor(posts, {
  // @ts-expect-error — `ctx.isAdmin` is `unknown` under the `user` scope.
  list: (ctx): { ok: boolean } => ({ ok: ctx.isAdmin }),
  purge: () => ({ ok: admin.isAdmin }),
  ping: () => ({ ok: true }),
});

const undeclared = defineContract(
  { prefix: 'ops', scope: 'user' },
  { run: { method: 'POST', path: '/run', desc: 'Run', scope: 'manager', output } },
);

implementFor(undeclared, {
  // @ts-expect-error — scope "manager" is not a key of the scope map; the error
  // lands on this endpoint and names the offending scope.
  run: () => ({ ok: true }),
});

// An endpoint hoisted out of the literal widens `scope` to `string`, which is
// not a key of the map either. Documented boundary of `const` inference, pinned
// here so the guide and the compiler cannot drift apart.
const hoisted = {
  method: 'POST' as const,
  path: '/hoisted',
  desc: 'Hoisted',
  scope: 'admin',
  output,
};

const widened = defineContract({ prefix: 'hoisted', scope: 'user' }, { hoisted });
implementFor(widened, {
  // @ts-expect-error — `scope` widened to `string`, which is not a key of the
  // scope map. Writing the endpoint inline keeps the literal and this compiles.
  hoisted: () => ({ ok: true }),
});

// A contract whose group scope is outside the map is rejected on the contract,
// not on each handler.
const foreign = defineContract(
  { prefix: 'foreign', scope: 'partner' },
  { read: { method: 'GET', path: '/', desc: 'Read', output } },
);

// @ts-expect-error — group scope "partner" is not a key of the scope map.
implementFor(foreign, { read: () => ({ ok: true }) });

// ─── createContractFactory: the per-endpoint scope joins the vocabulary ───

const { defineContract: scopedDefine } = createContractFactory<'public' | 'user' | 'admin'>();

scopedDefine(
  { prefix: 'valid', scope: 'user' },
  {
    read: { method: 'GET', path: '/', desc: 'Read', output },
    drop: { method: 'DELETE', path: '/', desc: 'Drop', scope: 'admin', output },
  },
);

scopedDefine(
  { prefix: 'typo', scope: 'user' },
  {
    // @ts-expect-error — "admn" is not a member of the factory's scope union.
    drop: { method: 'DELETE', path: '/', desc: 'Drop', scope: 'admn', output },
  },
);

const { defineContract: explicitDefine } = createContractFactory<'public' | 'admin'>({
  toolExposure: 'explicit',
});

explicitDefine(
  { prefix: 'explicit-typo', scope: 'public' },
  {
    // @ts-expect-error — the explicit-exposure factory holds the same union.
    drop: { method: 'DELETE', path: '/', desc: 'Drop', scope: 'user', output },
  },
);

// ─── Registry form ───────────────────────────────────────────────────────────

const implementAll = createScopedImplementRegistry<{
  public: object;
  user: { userId: string };
  admin: { userId: string; isAdmin: boolean };
}>();

const registry = { posts };

implementAll(registry, {
  posts: {
    list: (ctx) => ({ ok: ctx.userId.length > 0 }),
    purge: (ctx) => ({ ok: ctx.isAdmin }),
    ping: () => ({ ok: true }),
  },
});

implementAll(registry, {
  posts: {
    // @ts-expect-error — `isAdmin` belongs to the `admin` scope; `list` runs
    // under the contract's `user` scope, so it is `unknown` here.
    list: (ctx): { ok: boolean } => ({ ok: ctx.isAdmin }),
    purge: () => ({ ok: true }),
    ping: () => ({ ok: true }),
  },
});

// @ts-expect-error — a registry key without handlers is still rejected.
implementAll(registry, {});

// ─── Scoped streaming multipart ──────────────────────────────────────────────

const mediaOutput = z.object({ stored: z.string(), by: z.string() });
const media = defineContract(
  { prefix: 'media', scope: 'user' },
  {
    upload: {
      method: 'POST',
      path: '/',
      desc: 'Stream media',
      scope: 'admin',
      output: mediaOutput,
      multipart: { delivery: 'stream' as const, files: { file: {} } },
    },
  },
);

const receivers = {
  file: async ({ stream }: { stream: ReadableStream<Uint8Array> }) => ({
    value: await new Response(stream).text(),
    cleanup: () => undefined,
  }),
};

implementFor.stream('admin', media.endpoints.upload, {
  files: receivers,
  // The admin scope's fields are typed inside a streaming handler.
  handler: ({ files, userId, isAdmin }) => ({ stored: isAdmin ? files.file : '', by: userId }),
});

implementFor.stream(
  // @ts-expect-error — the endpoint declares `scope: 'admin'`; no other scope
  // may be claimed for it.
  'user',
  media.endpoints.upload,
  { files: receivers, handler: ({ files }) => ({ stored: files.file, by: '' }) },
);

// `HeadEndpointDef` declares its own `scope` outside `EndpointDefBase`. The
// factory constraint is structural, so it covers HEAD without a second rule.
scopedDefine(
  { prefix: 'head-typo', scope: 'public' },
  {
    // @ts-expect-error — "admn" is not a member of the factory's scope union.
    probe: { method: 'HEAD', path: '/probe', desc: 'Probe', scope: 'admn' },
  },
);

// ─── Regression: an endpoint with params/input must not collapse the context ──
// `HandlerContext` defaults `params`/`input` to `undefined`; intersecting that
// with an endpoint's inferred shapes reduces the whole context to `never`, and
// every assertion above would still pass because `never` is assignable to
// everything. This case is the one that catches it.

const detailed = defineContract(
  { prefix: 'detailed', scope: 'user' },
  {
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get one',
      params: z.object({ id: z.string() }),
      output,
    },
    search: {
      method: 'POST',
      path: '/search',
      desc: 'Search',
      input: z.object({ q: z.string() }),
      scope: 'admin',
      output,
    },
  },
);

implementFor(detailed, {
  get: (ctx) => {
    const id: string = ctx.params.id;
    const userId: string = ctx.userId;
    return { ok: id === userId };
  },
  search: (ctx) => {
    const q: string = ctx.input.q;
    const isAdmin: boolean = ctx.isAdmin;
    return { ok: isAdmin && q.length > 0 };
  },
});

// ─── An optionally-declared scope resolves to BOTH scopes, never silently to
// the group scope: at runtime the endpoint may or may not carry it.

const debugScope = Math.random() > 0.5;
const conditional = defineContract(
  { prefix: 'conditional', scope: 'user' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'Read',
      output,
      ...(debugScope ? { scope: 'public' as const } : {}),
    },
  },
);

implementFor(conditional, {
  read: (ctx): { ok: boolean } => {
    // Effective scope is `'public' | 'user'`; only one of them guarantees
    // `userId`, so it stays `unknown` instead of being typed off the group scope.
    // @ts-expect-error — `unknown` is not assignable to `string`.
    const userId: string = ctx.userId;
    return { ok: Boolean(userId) };
  },
});

// ─── .stream refuses an endpoint that does not declare its own scope ──────────

const inherited = defineContract(
  { prefix: 'inherited', scope: 'admin' },
  {
    upload: {
      method: 'POST',
      path: '/',
      desc: 'Stream',
      output: mediaOutput,
      multipart: { delivery: 'stream' as const, files: { file: {} } },
    },
  },
);

implementFor.stream(
  // @ts-expect-error — the endpoint declares no scope of its own, so its
  // effective scope comes from the contract and cannot be verified here.
  'admin',
  inherited.endpoints.upload,
  { files: receivers, handler: () => ({ stored: '', by: '' }) },
);

// ─── .stream refuses a scope that is not in the map ───────────────────────────

const foreignStream = defineContract(
  { prefix: 'foreign-stream', scope: 'admin' },
  {
    upload: {
      method: 'POST',
      path: '/',
      desc: 'Stream',
      scope: 'manager',
      output: mediaOutput,
      multipart: { delivery: 'stream' as const, files: { file: {} } },
    },
  },
);

implementFor.stream(
  // @ts-expect-error — scope "manager" is not declared in the scope map.
  'manager',
  foreignStream.endpoints.upload,
  { files: receivers, handler: () => ({ stored: '', by: '' }) },
);

// ─── The registry holds the group scope to the same map as the single form ────

const partner = defineContract(
  { prefix: 'partner', scope: 'partner' },
  { read: { method: 'GET', path: '/', desc: 'Read', scope: 'user', output } },
);

implementAll(
  // @ts-expect-error — group scope "partner" is not a key of the scope map,
  // exactly as `createScopedImplement(partner, …)` would report.
  { partner },
  { partner: { read: () => ({ ok: true }) } },
);
