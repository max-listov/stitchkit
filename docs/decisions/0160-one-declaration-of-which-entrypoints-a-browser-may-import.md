---
title: One declaration of which entrypoints a browser may import
description: Six places answered that question independently and drifted in both directions; the manifest is now the only one, the two build lanes collapse into one pass, and the guide and the consumer lane are asserted against it.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0160 — One declaration of which entrypoints a browser may import

## Decision

`packages/core/entrypoints.mjs` declares every published entrypoint once:
subpath, source module, and whether the package promises a browser can import
it. The build, both browser gates, the reference-coverage walk, the guide table
and the consumer-lane matrix are all checked against it.

There is one `bun build` over every entry, not a browser lane and a server lane.

## What was actually wrong

Six places answered "is this browser-safe" independently: two build script
strings, the `exports` map, the guide's Use-in column, the consumer-lane
`target`, and the entrypoint map inside `reference-coverage.test.ts`. That test
already asserted three of them against each other, which is why the drift that
shipped was in the pair it could not see:

- `stitchkit/remote` was sold by the guide as "browser **and** server, stable"
  while it sat in the server build lane. No gate ever bundled it for a browser,
  so the promise was unchecked for as long as it existed. It happened to be true.
- `stitchkit/declaration` was built for the browser and exercised for Bun.

Both were found by a reviewer reading the lists side by side. Neither could have
been found by a gate, because there was nothing for a gate to compare against.

Moving `remote` into the browser lane fixed the build and the guide and **still
missed the matrix** — a three-place edit where the fourth place is silent is not
a fix, it is the same defect one step along.

## Why one build pass

The two lanes carried byte-identical flags and differed only in their entry
lists. The split bought nothing and cost the first of these two things. It made the
entry lists a second place to declare browser-safety — the thing this ADR exists
to end — and two `--splitting` runs into one `--outdir` produce two chunk
graphs, so `dist` shipped the contract layer more than once.

The size result is mixed and worth stating exactly, because the tempting summary
is wrong. The whole `dist` is **115 KB smaller**: `defineContract` lived in two
chunks and now lives in one. But a single browser entry's graph is **larger** —
one pass gives the bundler more entries to split across, so `index.js` reaches 14
files instead of 7, and its transitive payload grew about 8%. What a consumer's
own bundler does with that depends on their splitting, and we have not measured
it. The honest claim is deduplication of the published package, not a smaller
download.

It also repairs `dev`, which had never worked. `bun run build:js -- --watch`
appends the flag to the tail of the expanded chain, so `--watch` landed on a
post-processing script that does not read argv, and `bun build --watch` had never
run at all.

## What is asserted, and what is not

The guide's Use-in column is prose with eleven distinct values —
"server (Node ≥ 22.5)", "terminal (Bun)", "build and deployment tooling". A
boolean cannot generate that without deleting information, so the column is not
generated. It is asserted: an entry the manifest calls browser-safe must say
"browser" there, and one it does not must not.

The consumer-lane `target` is not the same predicate either — it has three
values and one subpath legitimately has several rows. So the assertion is the
weakest true one: a browser-safe entry must have **at least one** row that
bundles it for a browser. That is exactly the check `remote` failed.
