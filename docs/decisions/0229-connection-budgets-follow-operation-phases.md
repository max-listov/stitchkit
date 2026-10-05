---
title: Connection budgets follow operation phases
description: Discovery and calls keep independent bounded policy and expected transport failures preserve safe public diagnostics.
status: active
created: 2026-10-04 12:49 +07:00
updated: 2026-10-04 12:49 +07:00
type: decision
---

# Connection budgets follow operation phases

**Invariants:** I8, I9, I10, I13.

The existing MCP connection client owns one phase policy. Discovery covers initialization,
initialized notification, tools/list and legacy endpoint readiness; tools/call has a separate
budget. Shared timeout and byte options remain the baseline for both phases, with explicit
per-phase overrides. Finite validation prevents an invalid value from creating unlimited
waiting or reading. Tool mount and schema ceilings remain separate constraints.

One operation deadline covers Streamable HTTP negotiation and its allowed legacy fallback.
The discovery deadline does not bound the lifetime of an established SSE session. Each
pending response has its own phase and byte ceiling, while unsolicited frames remain bounded.
Only initial initialization may negotiate another transport. A failed side-effecting call is
not sent again to guess whether another transport will work.

Bodies and frames count observed raw UTF-8 bytes, including chunk boundaries. A reported
observed count is what the client read before cancellation; it is not an inferred response
total or a trusted Content-Length. Exactly the declared ceiling is accepted. Readers,
pending requests and sessions are released after refusal. Caller cancellation keeps its
own cause and is distinct from the client's deadline.

The existing connection error owner provides public typed stage, reason and finite limits.
Expected failures project into the canonical AppError and tool result mechanism; the original
cause stays in existing in-process observation. Public fields exclude URLs, credentials,
headers, response bodies and stacks. A deterministic byte ceiling does not suggest that the
same call will succeed if repeated. A timeout likewise does not prove absence of the effect.

Tool failures do not print raw exceptions into the CLI's stderr beside its parseable error
record. Unknown exceptions keep their scrubbed envelope and their full in-process cause.
HTTP's default internal logging remains its own boundary. Authorization, permission,
upstream failures and remote structured refusals retain their distinct semantics.

Qualification measures opposite phase overrides, exact byte boundaries, JSON and both SSE
paths, caller abort, credential fences, missing responses and forbidden replay from the real
public package in Bun and Node, including a compiled CLI.
