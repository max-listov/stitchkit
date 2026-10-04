---
title: HTTP remote retains error policy and caller signal
description: Remote composition uses the existing typed client options and preserves explicit error recommendations without treating cancellation as proof of effect termination.
status: active
created: 2026-10-04 13:40 +07:00
updated: 2026-10-04 13:40 +07:00
type: decision
participants:
  - role: authored
    harness: Codex Desktop
    model: GPT-6
    at: 2026-10-04 13:40 +07:00
---

# HTTP remote retains error policy and caller signal

**Invariants:** I8, I9, I10, I13.

An AppError with status 502 and retryable=false previously retained that recommendation
through direct CLI invocation but lost it through HTTP remote composition. The HTTP error
envelope omitted the declaration, so the remote tool derived true from the status. Independently,
implementRemote called the typed method without its request options, discarding caller signal.

The canonical ErrorEnvelope carries an optional boolean retryable only when explicitly
declared. ApiError preserves it as an eighth constructor argument; its existing seventh
ErrorOptions argument remains compatible. Both HTTP adapters and framed contract-stream
errors carry the declaration. implementRemote translates recognized errors through AppError,
retaining details, hint and trace metadata; unexpected local transport errors remain raw for
the existing safe normalization boundary and internal cause observers.

This metadata does not change the HTTP transport's retry engine. Undefined retains its
previous meaning. A closed consumer error schema must accept the optional field before its
producer begins declaring it; streams keep strict boolean validation.

implementRemote calls the existing withOptions method with RuntimeContext.signal. One shared
endpoint argument predicate chooses the existing argument/no-argument overload. Pre-aborted
calls and cancellation during an asynchronous argument transform dispatch no HTTP request.
Local cancellation becomes safe REQUEST_ABORTED, status 499, retryable=false, CLI exit130;
a local deadline is REQUEST_TIMEOUT, status408, exit7, retryable=false.

Cancellation stops the caller's HTTP operation. Cooperative server handlers observe their
request signal and release permits and locks in their actual completion path. An origin or
external provider ignoring cancellation may continue; a rejected wait never substitutes for
physical completion. Installed probes observe a real listener, live permits/locks, an ignoring
origin and a genuine compiled CLI receiving SIGTERM, independently of local invocation results.

No second HTTP client, remote executor, signal lifecycle or consumer error renderer is added.
