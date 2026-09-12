---
title: "ADR 0181: A sandbox backend is an optional two-phase contract with an explicit network policy"
description: "Isolation becomes a swappable backend behind an opt-in config: create/prewarm, a stop that preserves the durable session and a delete that does not, and a network policy whose per-domain transform brokers a credential without putting it in the sandbox."
type: decision
status: accepted
created: 2026-09-12
updated: 2026-09-12T17:51+07:00
---

# ADR 0181 — A sandbox backend is an optional two-phase contract with an explicit network policy

## Context

The coding tools declare themselves a root boundary, not an OS sandbox: process
isolation is the host's. That is an honest boundary, but it leaves every host to
invent its own way of denying egress and keeping secrets out of a long-running
agent's environment. A secret that must be used by a command inside the sandbox
should reach the network through the firewall, not the process.

## Decision

A new optional subexport defines a backend contract, and nothing changes unless
it is configured.

- **Two phases.** `prewarm` captures a template at build time; `create` opens a
  live session from it. `name` participates in both the template key and the
  persisted reconnect record, so switching backends never reuses another one's
  template.
- **The minimal backend is byte I/O plus `spawn`;** the public session (text and
  binary reads, `run`, path resolution) is built on top once, not re-implemented
  per backend.
- **Lifecycle is named for what it destroys.** `stop` stops compute and keeps
  the durable session reattachable; `shutdown` stops compute without leaving
  anything running; `delete` removes compute and disposable state but never a
  shared or reusable template.
- **Network policy is explicit.** `allow-all`, `deny-all` and a domain allow-list
  are supported; fixed per-origin headers are injected by the host HTTP gateway so the
  credential never enters the sandbox. A backend that cannot enforce a requested
  policy refuses with a named error instead of silently allowing.

## Alternatives

- **Keep isolation entirely with the host.** Rejected as an answer, not as a
  default: it stays the default, but a consumer cannot state a network policy or
  broker a credential through the framework at all.
- **Ship several provider adapters.** Rejected: one reference backend proves the
  contract; aliases and extra adapters without a second implementation are a
  second implementation of one thing (ADR 0170).
- **A per-step sandbox.** Rejected: sandbox identity is a session- and
  turn-boundary fact; a step-lived sandbox would churn the identity tool and
  parking stability depend on.

## Consequences

This changes a declared boundary, so it starts with this ADR and ships behind an
opt-in config; without explicitly creating a sandbox session, behaviour is exactly as today. The
first slice is the contract, one reference local backend, and the tests for
`deny-all`, the header broker and `stop`→reattach.

## Reference implementation

`createSandboxCodingTools` composes the maintained coding profile over the handle's
host workspace and process adapter. File tools retain their contained-file engine;
shell commands retain their bounded output/artifact engine. The backend owns the
launcher, so all commands share stop and concurrency admission. Required restrictions
are checked when preparing a command, and policy revisions fence delayed launches.

The opt-in entrypoint is `stitchkit/agent-runtime/sandbox`. Its Linux Bubblewrap
backend uses isolated namespaces and a private host HTTP gateway over a Unix
socket. The allow-list contains exact origins and optional fixed headers; it is
not a transparent firewall or a CONNECT proxy. Direct TCP and DNS remain denied.
Authorized upstreams must be trusted not to reflect injected credentials.

Templates snapshot supplied byte files and include their contents in the key.
Reconnect requires the same backend and template and an exclusive session lease.
Stop/shutdown preserve workspace files; delete preserves the reusable template.
A crashed host requires operator verification before stale lease removal.
There are command deadline/output and gateway bounds, but no VM, cgroup quotas
or automatic recovery guarantee. See [the sandbox guide](../guide/sandbox.md)
for the full supported boundary and [Bubblewrap](https://github.com/containers/bubblewrap)
for the isolation mechanism. Existing coding tools are not automatically redirected.
