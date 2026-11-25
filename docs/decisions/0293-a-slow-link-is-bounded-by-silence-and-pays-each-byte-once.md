---
title: "ADR 0293: A slow link is bounded by silence and pays for each byte once"
description: A connection's idle deadline ends an exchange only when nothing arrives, a stored MCP catalog is used while the server's catalog stamp is unchanged, and an interrupted CLI download continues from its kept part.
type: decision
status: accepted
amends: ["0229"]
created: 2026-11-17 18:12 +07:00
updated: 2026-11-17 18:12 +07:00
---

# ADR 0293 — A slow link is bounded by silence and pays for each byte once

Amends [ADR 0229](0229-connection-budgets-follow-operation-phases.md). Serves **I9**, **I10**, **I13**.

## Context

A consuming project's CLI, on a 40–60 KB/s link, could not start: every server command mounts
the server's catalog first, a catalog of a few hundred tools is about 800 KB, and discovery had one
30-second deadline for negotiation, waiting and reading. It could not update either: a 42 MB
build had 120 seconds, and every attempt began again from zero. The server answered throughout.
A deadline on the whole exchange cannot tell a slow link from a dead one, and a client that
re-downloads what it already holds spends the slow link on nothing.

## Decision

**Silence, not length, ends a live exchange.** An MCP connection phase takes `idleTimeoutMs`: the
operation fails when nothing has arrived for that long, and the response headers and every body
chunk restart it. It sits inside the operation's total deadline, which stays (amended from ADR
0229: "one operation deadline" is now one total deadline plus an optional idle one). Unset,
discovery allows 300 seconds in total and 30 seconds of silence; a call keeps 30 seconds and has
no idle deadline, because a tool may legitimately compute in silence before its answer starts. A
declared `timeoutMs`, connection-level or per phase, keeps meaning exactly that deadline: the
discovery defaults replace an undeclared deadline as a pair, and an idle deadline exists beside
a declared one only when it is declared too. `applyCliUpdate` follows the same rule. The failure is the same
`ConnectionTimeoutError` and projection reason, saying which `deadline` fired.

**A stored catalog is mounted while it is the served one.** The key is the catalog stamp the
server already publishes — a digest of what `tools/list` advertises for the caller's surface —
never `serverInfo`, whose version a server rarely changes and which says nothing about which
surface a credential sees. `createMcpHandler` sends the stamp of the surface it served as the
`stitchkit-catalog` response header (the SDK assembles the `initialize` result and leaves no
`_meta` to fill); a connection given `catalog: { load, store }` compares it before listing.
`initialize` and `tools/list` are separate requests that a rolling deploy may answer from two
builds, so a listing is stored only when every tool in it carries the announced stamp and their
number matches, and a stored entry is used only on the same proof. A surface with raw SDK tools
sends no stamp, because part of its catalog is outside the digest. The digest therefore covers
everything Stitchkit publishes per tool, the MCP Apps `ui` resource included. It does not hash
the JSON Schema text the server's SDK renders from the same schema: a change of that rendering
with unchanged declarations keeps the stamp, and a client keeps the older rendering until the
contract moves.

**An interrupted download continues; a continued file is never trusted.** `applyCliUpdate`
bounds its download by `idleTimeoutMs` (default 30 seconds) and a long total `timeoutMs`
(default 30 minutes). Given a `partialPath`, it appends to that file and records beside it the
URL, the build's digest and the server's validator, and the next attempt asks for the rest with
`Range` and `If-Range`. The server decides what the part is worth: `206` from the right offset
continues it, `200` replaces it, `416` with the full length says it is whole. The finished bytes
are decoded and checked against the manifest exactly as a fresh download is; a continued file
that fails is discarded and downloaded once more from zero, a fresh one that fails is a refusal.
The part is removed once decoded either way, and a lock refuses a second download into it.
Without `partialPath` nothing is kept: the location is application state, as `backupPath` is.

## Consequences

A slow link that keeps delivering completes discovery and updates under the defaults, and a dead
one still fails within 30 seconds of silence. A start with an unchanged catalog transfers no
catalog. Every catalog stamp moves once with this release, because the digest now covers `ui`.
Qualification: a socket throttled to 50 KB/s and one that stalls, for discovery and for the
download; a changed catalog, a changed surface and a split rolling deploy as negative controls of
the cache; a cut, a corrupted part, a re-published build and an already whole part for the
download.
