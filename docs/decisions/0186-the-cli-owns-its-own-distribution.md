---
title: "ADR 0186: The CLI surface owns aggregates, profiles and its own distribution"
description: "Four things every consumer of createCli rebuilds — aggregate views, named credential profiles, an installer generated from a manifest, and a bounded update check — become framework surface, with the dangerous variant of each one refused rather than documented."
type: decision
status: accepted
created: 2026-09-16
updated: 2026-09-16T14:14+07:00
---

# ADR 0186 — The CLI surface owns aggregates, profiles and its own distribution

## Context

A consumer built a CLI on top of its own runner rather than on `createCli`, and
the report named exactly what was missing. Each item is the same shape: work no
application should own, where the *convenient* implementation is the unsafe one,
so documenting the rule is not enough — the rule has to be the code.

## Decision

**Aggregate views (`--count-by`, `--sum`, `--top`, `--table`).** `cli-format`
decided that CLI output is JSON because the audience is agents, scripts and `jq`.
The first half is right; "so it must be the whole collection" does not follow
from it. Measured on a live server: a 98-record listing is 34 750 characters in
an agent's context window, and the question asked was "how many per status" —
~90 characters. `| jq` cannot help, because the bytes have already been read into
the conversation by the time the pipe sees them. The aggregate is computed on the
result, before anything is written. `--by` names the grouping field in every form
it appears in, so the grammar has one meaning. A field no record carries is an
argument error: a group of zero over a misspelled field is indistinguishable from
a true empty answer, and the caller reads it as data.

**Named credential profiles.** `--profile prod` is how a person picks an
environment, and the unsafe implementation reads as kindness: *the named profile
does not exist, but exactly one is configured — use it.* It is correct exactly
while a single profile exists, and a wrong-environment command the day a second
appears. A consumer hit it, asking for `prod` on a machine holding only `dev` and
reading a plausible answer. So: **a name given and not found is a refusal.**
Substitution survives only where it cannot be wrong — no name given, exactly one
profile — and is announced. The distinction is drawn at resolution, because one
step later "prod" and "prod by default" are the same string.

**Distribution and self-update.** `createCli` ships no executable and should not;
but the step after the executable is not application logic either. One consumer
implemented it end to end and met three traps a shared primitive absorbs once:
the installer cannot parse the manifest (a `curl … | sh` machine has no `jq`), so
it is generated *from* the manifest with the URL and digest substituted;
replacing a running binary is a rename, never a write; and the digest covers the
**decompressed** bytes, because those are what will be executed. Publishing the
same version from a different commit is refused, otherwise everyone who already
installed that version never receives the fix. The check has four answers —
`skipped`, `current`, `outdated`, `unknown` — because "could not ask" is not "up
to date", and it never replaces the binary by itself.

**Commands discovered from a running server.** `mountConnections` + `createCli`
already composed into a CLI whose surface is the one the server has *now*, except
that discovered tools were filtered out of the CLI projection with no declarative
way in, and the only route through was for the consumer to spread the framework's
own definition objects. The opt-in is `transports` on the connection: a whole
server becomes a set of commands. The default is unchanged — CLI exposure stays
explicit, as everywhere else.

## Consequences

`stitchkit/cli` grows, and stays free of the MCP and AI peers: the manifest is
Zod, the installer is string generation, and the update primitive is
`node:crypto`/`node:zlib`/`node:fs`. `coerceJsonArgs` is re-exported here beside
the parser whose contract it completes, so a consumer that parses argv and sends
the call itself needs both halves without reaching for the heavy barrel.

What the framework deliberately does **not** own: where assets live, which
platforms are published, who may download them, and where a profile directory
sits. Those are application decisions, and a framework that answered them would
be answering them wrongly for someone.
