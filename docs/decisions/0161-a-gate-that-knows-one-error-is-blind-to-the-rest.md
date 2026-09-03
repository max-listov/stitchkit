---
title: A gate that recognises one error is blind to every other
description: The consumer lane ran the strict declaration check that would have named five TS2344 errors in a packed .d.ts, printed them, and dropped them because its parser knew only "Cannot find" — the filter is now inverted.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0161 — A gate that recognises one error is blind to every other

## Decision

The consumer lane's declaration check **subtracts** what is knowingly accepted
and fails on the remainder, instead of **matching** the one diagnostic shape it
was written for. An unresolved optional peer is still a judgement call and still
lives in `ACCEPTED_UNRESOLVED`; everything else the compiler says about a packed
`stitchkit` declaration now fails the lane.

## What it missed

`createAsyncOperationSnapshotSchema` builds its object shapes with a conditional
spread:

```ts
const progress = config.progress ? { progress: config.progress.optional() } : {};
z.object({ phase: z.literal('pending'), ...progress });
```

TypeScript infers that shape as a **union** — one branch with `progress`, one
with `progress?: undefined` — and zod constrains a shape to
`Record<string, $ZodType>`, which the second branch does not satisfy. Checking
source never surfaces it: the shape stays internal and the check passes. Writing
a declaration does surface it, once per phase, five times, in
`dist/tools/async-operation-contract.d.ts`. Any consumer with
`skipLibCheck: false` reads them, and `stitchkit/tools/contract` exists
*specifically* for consumers.

It shipped in 0.78.0 and again in 0.79.0. Not because no gate ran: the consumer
lane runs `tsc --skipLibCheck false` against the packed tarball for every
fixture, and had been printing those five errors the whole time. The lane then
walked the output like this:

```js
for (const line of libCheck.split('\n')) {
  if (!line.includes('node_modules/stitchkit/')) continue;
  const module = line.match(/Cannot find module '([^']+)'/);
  const namespace = line.match(/Cannot find (?:namespace|name) '([^']+)'/);
  // …anything that matched neither was discarded
}
```

The check was right, the target was right, the output was in hand. The parser
recognised one error class, and a diagnostic that was not an unresolved
reference left no trace — a run with five defects in it printed exactly what a
clean run printed.

## Why this shape and not a longer pattern list

Adding `TS2344` to the patterns would fix this instance and reproduce the
defect: the next unfamiliar code is silently discarded again, and the gate keeps
reporting clean. The failure is not a missing pattern, it is a filter that
decides what to *see*. Inverting it makes the unknown loud by default, and puts
the burden on the accepted list — which is short, reviewed, and already the
place where this lane records a judgement.

The measured cost of the strict shape is bounded: across all 29 entrypoints,
`skipLibCheck: false` produces exactly zero diagnostics in stitchkit's own
declarations once the snapshot factory is fixed. The lane is not being asked to
tolerate a backlog.

## The fix under it

`createAsyncOperationSnapshotSchema` is two overloads, each returning a named,
written-out union — `AsyncOperationSnapshotSchema<TFailure>` and
`AsyncOperationSnapshotSchemaWithProgress<TProgress, TFailure>`. The conditional
spread stays in the implementation, where it is a value and correct, and never
reaches a declaration.

Not a normalised key. Substituting `z.never().optional()` for the absent
`progress` would make one uniform shape and delete the whole problem — and would
turn a snapshot that used to *strip* an unexpected `progress` into one that
rejects it. The defect is in the types; the runtime does not move to fix it, and
`tests/async-operation.test.ts` now pins that strip.

The same spread had a second effect nobody had noticed, and it is the one that
makes this a minor rather than a patch. Narrowing `config.progress` inside the
ternary widens it back to a bare `ZodType`, so the declaration erased the type
argument: `z.output<typeof schema>['progress']` was `unknown` in every published
copy. Measured against the 0.79.0 tarball from the registry rather than from
memory — `const s: Snap = { phase: 'running', progress: 'a string' }` compiles
there and is `Type 'string' is not assignable to type '{ done: number; }'` now.
An error union that does not typecheck is loud; a type quietly widened to
`unknown` is not, and it had shipped for longer.

## And the entry was covered by a coincidence

Inverting the filter is only half of it. The five errors surfaced in the `full`
fixture — the one that installs every optional peer — because it imports
`stitchkit/tools`, whose declaration re-exports the contract module. No fixture
named `stitchkit/tools/contract`, so `dist/tools-contract.d.ts` itself was never
in any program, and the coverage of the module behind it would have vanished
silently the day `full` stopped importing `stitchkit/tools`.

An entrypoint built for a peer-free browser client, checked only through the
fixture that installs everything, is being checked for the wrong thing.
`fixtures/minimal/src/tools-contract-conformance.ts` imports it by name, in the
peer-free fixture, names both return types, and runs the parses — so the entry
is now anchored rather than reached sideways.

## Consequence

- A diagnostic in a packed declaration fails the release, whatever its code.
- A newly unresolvable optional peer is a listed decision, as before.
- The no-progress overload has runtime tests. It had none: every caller in this
  repository, in the guide and in the examples configures `progress`, which is
  why the broken half of the union was written down for two releases and never
  once executed.

## Related

- ADR 0156 — a schema a browser cannot import is not a contract (why this
  entrypoint exists at all).
- ADR 0158 — a gate that does not run the code is measuring a proxy (the same
  failure one layer out: the check was real, what it looked at was not).
