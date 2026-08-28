---
title: Managed server factories need their declared resource context
description: Allow a managed server factory to consume published dependency values without an outer mutable handoff or overriding adapter start.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: P1
---

## Зачем

Published 0.67.0 has two individually working APIs that cannot be composed:
an ordinary resource reads a dependency with context.use(resource), but
managedServerResource.server is a zero-argument factory. Its implementation calls
config.server() without the ManagedResourceContext received by start.

A server depending on a socket/service/database resource cannot read the declared
value when constructing routes. Keeping a mutable outer reference or overriding
the adapter start reinstates the handoff the resource-value API removes.

## Published reproduction

Installed registry stitchkit@0.67.0, integrity
`sha512-rpE+YtW/tLYJOqV4Yj0GfpZ68Ge1rYqg+TZDnycgJBsTYqYe9S4/fCNvOwHg7hUlcIwzsNsQxamp4lYKLxlJqw==`.
Bun1.3.14: dependency.start returns { value: { message: 'ready' } };
an ordinary dependent reads 'ready'; a managed server factory declared as
(...args) => createServer({ port: 0, services: [] }) receives [].
Application starts and shuts down cleanly. This is missing composition, not a
failure of delayed binding itself.

With strict TypeScript and moduleResolution=bundler:

```ts
const dependency = defineManagedResource({
  id: 'dependency', start: () => ({ value: { message: 'ready' } }),
});
managedServerResource({
  id: 'http', dependsOn: [dependency],
  server: (context: ManagedResourceContext) => {
    const value = context.use(dependency);
    return createServer({ port: 0, services: [] });
  },
});
```

The callback produces TS2322: target signature provides too few arguments;
expected 1 or more, but got 0. Tested against installed declarations, not HEAD.
Source: packages/core/src/application/server-resource.ts, resource.ts.
Related design: ADR0114 and ADR0115; do not reopen their completed tasks.

## Результат

A supported typed factory can access its declared dependencies and startup signal.
One managed adapter owns server start/shutdown; no consumer lifecycle shim.
Preserve already-created handles and zero-argument factories where compatible.

## План

- [x] Reproduce the published runtime and typing gap.
- [x] Pass the managed resource context to the server factory with correct public inference.
- [x] Prove value access, undeclared dependency refusal, thrown/async factory rollback and signal lifetime.
- [x] Update architecture decision/index, guide, declarations and migration notes.
- [x] Publish through full verify, exact-SHA CI and packed-consumer gates.

## Acceptance

- [x] A packed consumer builds a real listening server using a typed dependency value; no outer handle or start override.
- [x] Sync and async factories see the correct context; dependency failures prevent binding.
- [x] Failed creation runs once and rollback neither invokes the factory again nor masks the original error.
- [x] Shutdown remains bounded, signal-aware and singly owned; existing handle/factory cases retain behavior.
- [x] Return exact version/tag/SHA, registry integrity, import paths and runnable migration proof.

## Что сделано

- [x] `packages/core/src/application/server-resource.ts` passes one typed
      `ManagedResourceContext` to sync and async factories without changing
      handle or zero-argument factory behavior.
- [x] Regression: `packages/core/tests/application-server-resource-start.test.ts` —
      `a factory reads its declared dependency value and startup signal`,
      `an async factory receives the same typed context before dependants start`,
      `an undeclared dependency read fails once and preserves the factory error`,
      `a failed dependency prevents the server factory from binding`, and
      `an async factory rejection is not invoked again during rollback`.
- [x] Packed proof: `packages/core/scripts/consumer-lane/fixtures/minimal/src/application-migration-recipes.ts`
      constructs from a declared value and verifies the lifecycle signal.
- [x] ADR 0121, application guides, reference and changelog describe the public
      contract. Full `bun run verify` passed; release evidence is attached to
      the immutable `v0.68.1` tag and registry artifact.
