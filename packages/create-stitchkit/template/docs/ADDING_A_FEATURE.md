# Adding a vertical feature

This guide uses a small `status` resource to show the canonical path. The blank
scaffold starts with only its HTTP readiness endpoint and no application or tool
surface. In `--example repository` mode, keep the repository slice and add the
same files beside it.

## 1. Define the wire data

Create `packages/shared/src/schemas/status.ts` (created in this step):

```ts
import { z } from 'zod'

export const StatusSchema = z.object({ message: z.string().min(1) })
export const UpdateStatusInputSchema = StatusSchema
export type Status = z.infer<typeof StatusSchema>
```

Export it from the shared package. Do not introduce a second handwritten DTO.

## 2. Define the HTTP/tool contract separately

Create `packages/shared/src/contracts/status.ts` (created in this step) and import the named schemas:

```ts
import { defineContract } from 'stitchkit'
import { StatusSchema, UpdateStatusInputSchema } from '../schemas/status'

export const statusContract = defineContract(
  { prefix: 'status', scope: 'public' },
  {
    read: { method: 'GET', path: '/', desc: 'Read status', output: StatusSchema },
    update: {
      method: 'PUT', path: '/', desc: 'Update status',
      input: UpdateStatusInputSchema, output: StatusSchema,
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
    },
  },
)
```

The contract owns transport identity. Do not add a raw route or duplicate path.

## 3. Implement and register the service

Create `packages/backend/src/transport/status-service.ts` (created in this step) with `implement()`.
Keep persistence and business rules in a domain/service module; the contract
handler calls that module once. Add the returned service to the `services` array
in `packages/backend/src/surface.ts`. That one registration drives HTTP,
OpenAPI, MCP, agent tools and CLI discovery.

## 4. Add typed browser access

Export `statusContract` from `packages/shared/src/index.ts`.

The scaffold ships no browser transport layer, and that is the first thing this
step builds. It also makes one decision for you, because the starter already
made it: **no address is compiled into the artifact.** `packages/frontend/src/env.ts`
declares no `client` block on purpose — a `NEXT_PUBLIC_` variable is substituted
at build time, which freezes a value of the place into the bundle. So the client
is a factory over an origin the server reads per request, never a module-level
constant.

Create `packages/frontend/src/lib/api/client.ts` (created in this step):

```ts
import { createClient, createHttpClient } from 'stitchkit'
import { statusContract } from '@app/shared'

/** One origin per request, supplied by the server — never read from the bundle. */
export function createStatusApi(origin: string) {
  return createClient(statusContract, createHttpClient({ prefixUrl: origin }))
}
```

Create `packages/frontend/src/lib/api/status.ts` (created in this step) for the
query key and the react-query-kit hooks, and keep the key canonical — one key
per resource, updated or invalidated on mutation success.

A server component reads `env.PUBLIC_API_ORIGIN` and hands it down as a prop;
the client component calls `createStatusApi(origin)`. That is the whole reason
`PUBLIC_API_ORIGIN` is a server variable rather than a public one.

Render the hook from a feature component. Pages compose features; they do not
call `fetch`, construct `/api/status` or decode error bodies themselves.

## 5. Add realtime only when another client must observe the change

Create `packages/shared/src/realtime.ts` (created in this step) and declare the
event there with a named Zod schema for its tuple — the scaffold ships no
realtime module, so this step introduces it rather than assuming it. The server emits after the domain change succeeds; the frontend cache
bridge reacts by updating or invalidating the status query. Keep handshake auth,
authorization and room membership in the application. Socket.IO delivery,
reconnection, retained subscriptions and validation belong to Stitchkit.

The starter advances its single `catalog.stitchkit` target only after the
required framework release exists. Do not copy a framework adapter into the
application or maintain a parallel event-map API.

## 6. Prove the surface and behavior

Generic smoke already derives expected HTTP operations and MCP tool names from
the registered services and compares them with live OpenAPI/MCP discovery. Add
an explicit probe only for handler behavior:

```ts
defineSurfaceProbe({
  name: 'status update lifecycle',
  input: UpdateStatusInputSchema,
  fixture: { message: 'Ready' },
  output: StatusSchema,
  run: (input) => statusClient.update(input),
})
```

Add domain tests beside domain code, contract/schema tests in shared, and UI E2E
only for user-visible behavior. Finish with the commands in root `AGENTS.md`.

## Ownership boundary

Application-owned: domain policy, persistence, auth decisions, rooms, cache
semantics and presentation. Framework-owned: contract routing, validation,
normalized errors, transport lifecycle, tool discovery and Socket.IO wrappers.
When the framework-owned layer is missing a generic capability, fix Stitchkit
and upgrade this application's one catalog target after that release exists.
