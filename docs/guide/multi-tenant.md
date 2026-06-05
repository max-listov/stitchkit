# Multi-tenant / resource-scoped paths

A walkthrough of one mainstream scenario end-to-end: a SaaS API scoped by a path
segment — `/tenants/:tenantId/widgets/...` — where the same `tenantId` gates
access in auth and is injected into tool calls (one API key → many tenants).

Every piece below already exists; this recipe wires them into one flow. Each step
links to its reference section.

## 1. The contract — tenant-agnostic

Endpoints know nothing about the tenant; the path segment lives on the group, not
the endpoint:

```ts
export const widgets = defineContract(
  { prefix: 'widgets', scope: 'tenant' },
  {
    list: { method: 'GET', path: '/', desc: 'List widgets', output: WidgetList },
    create: { method: 'POST', path: '/', desc: 'Create a widget', input: NewWidget, output: Widget },
  },
)
```

## 2. The server — a param prefix

Mount the service under a group whose `pathPrefix` carries `:tenantId`. The
matched value is on the context root as `ctx.tenantId`
([details](./server.md#param-prefixes-resource-scoped-paths)):

```ts
createServer({
  groups: [
    { pathPrefix: '/tenants/:tenantId', services: [widgetsService], hooks: { beforeHandle: authHook } },
  ],
})
// → /tenants/:tenantId/widgets
```

With more than one scope, let **`scopePrefixes`** map `scope → prefix` and mount
the flat `services` list — no hand-partitioning, the mapping lives in one place
([details](./server.md#scope-driven-mounting-scopeprefixes), → ADR 0024):

```ts
createServer({
  services,                                  // mixed scopes, listed once
  scopePrefixes: { tenant: 'tenants/:tenantId', project: 'projects/:projectId' },
  hooks: { beforeHandle: authHook },
})
// `tenant`-scoped → /tenants/:tenantId/..., `project` → /projects/:projectId/..., the rest flat
```

Handlers read `ctx.tenantId` (a raw `string` — narrow it). To get it typed inside
`ctx.params`, add `tenantId` to the endpoint's `params` schema (a `z.strictObject`
that omits it will reject the request). When each scope guarantees different
injected fields, call `createImplement<TenantCtx>()` / `createImplement<BaseCtx>()`
**once per scope** and implement each contract with the matching factory — every
handler is typed to its scope, with no superset context that lies about a
`tenantId` a `public` handler never has.

## 3. Auth — gate the tenant in the path

The `tenant` scope rule reads the prefix param and checks access; `inject` puts
the identity and derived facts on `ctx`
([details](./auth-and-errors.md#resource-scoped-rule--reading-a-pathprefix-param)):

```ts
const authHook = createAuthHook<User>({
  resolve: sessionResolver,
  rules: {
    public: 'public',
    tenant: (user, ctx) => userCanAccessTenant(user.id, String(ctx.tenantId)),
  } satisfies Record<Scope, AuthRule<User>>,
  inject: (ctx, user) => { ctx.user = user },
})
```

## 4. The client — a per-tenant `pathPrefix`

`createClient`'s third argument prepends the tenant segment; `stripPrefixKeys`
keeps `tenantId` out of the body/query
([details](./client.md#contractclientconfig--per-tenant--resource-scoped-clients)):

```ts
const widgetsApi = createClient(widgets, http, {
  pathPrefix: (args) => `tenants/${args.tenantId}/`,
  stripPrefixKeys: ['tenantId'],
})

widgetsApi.list({ tenantId: 't_123' })   // GET /tenants/t_123/widgets
```

`stripPrefixKeys` (a `const` tuple) also makes the consumed keys **typed,
required args** on every method — `tenantId` above is type-checked, not a runtime
surprise — so no hand-written scoped-client wrapper is needed (→ ADR 0025).

## 5. The AI surface — `extend` injects the tenant

One API key serves every tenant: the model passes `tenantId` per call, `resolve`
validates it and puts it on `ctx` — so the *same* handler that reads `ctx.tenantId`
over HTTP serves the tool call
([details](./mcp-and-agents.md#adding-tool-only-args--extend)):

```ts
createMcpHandler({
  serverInfo, auth,
  services: [widgetsService],
  lifecycle: { beforeHandle: authHook },
  extend: {
    schema: { tenantId: z.string().describe('Tenant to act on') },
    resolve: async ({ tenantId }) => ({ tenantId: String(tenantId) }),
    filter: (_s, m) => m.scope === 'tenant',
  },
})
```

## The through-line

`ctx.tenantId` is the single join point: the **prefix param** puts it there on
HTTP, `extend`'s **resolve** puts it there on a tool call. Handlers and the auth
rule read it the same way on both surfaces — one contract, every surface, no
per-transport tenant plumbing.
