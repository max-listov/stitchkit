---
title: "ADR 0287: A read says it reads on every tool surface"
description: The MCP server publishes readOnlyHint for a GET that declared none, and a client connection carries published hints onto the tools it mounts, so one rule decides a read over the contract and over MCP.
type: decision
status: accepted
created: 2026-11-10 14:31 +07:00
updated: 2026-11-10 14:31 +07:00
---

# ADR 0287 — A read says it reads on every tool surface

Serves **I1**, **I2**, **I13**. Amends [0286](0286-a-refused-view-withholds-a-read-and-keeps-an-effect.md).

## Context

0286 let a managed CLI command withhold its result after a refused view when the command only
reads, and decided "only reads" from the tool's declared `readOnlyHint`, falling back to the
contract method being `GET`.

A consuming project builds its CLI by mounting its own server's tools through
`defineMcpClientConnection`. On that path the rule never fired, for two reasons that each
sufficed. The server published only declared annotations, so a `GET` endpoint without them
carried no hint. And the client connection read a tool's name, description and input schema
from `tools/list`, mounted it as a `POST` — which an MCP call is — and dropped the annotations.
The same command printed nothing over the contract and 154 KB over MCP. The alternative offered
to the consumer was to write `readOnlyHint: true` on several hundred `GET` contracts: the method
declared a second time.

## Decision

Whether an operation only reads is one rule with one owner, read by every surface:

- The operation only reads when it declares `readOnlyHint: true`, or declares no `readOnlyHint`,
  its method is `GET` and it does not declare `destructiveHint: true`. This amends 0286: a `GET`
  that calls itself destructive is not a read.
- The MCP server publishes the declared annotations and states `readOnlyHint: true` for a read
  that declared none. Publication happens at the single registration point, so contract tools,
  runtime tools and multi-round tools cannot differ. The catalog digest hashes what is
  published.
- A client connection carries the annotations a server published onto the tools it mounts. They
  are read field by field; a field of the wrong type is dropped and the tool stays, because a
  hint is advice about a tool that works without it.

The surface manifest keeps recording declared annotations: it snapshots the contract, not a
transport's presentation of it.

## Consequences

A server that upgrades starts publishing `readOnlyHint: true` for its `GET` tools, and its
catalog digest moves once. An MCP host may run such a tool without asking, so a `GET` endpoint
with an effect must declare `readOnlyHint: false`.

A mounted tool is as read-only as its server says. A server that labels a write as read-only
makes a CLI withhold that write's result on a refused view, and repeating the command repeats
the effect. The connection is the trust boundary the application already chose; the hint is not
verified, and the guide says so.
