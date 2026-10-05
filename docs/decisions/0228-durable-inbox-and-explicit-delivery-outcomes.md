---
title: Durable inbox and explicit delivery outcomes
description: One existing inbox accepts programmatic identities under fenced storage, while delivery retries require explicit evidence.
status: active
created: 2026-10-04 12:49 +07:00
updated: 2026-10-04 12:49 +07:00
type: decision
---

# Durable inbox and explicit delivery outcomes

**Invariants:** I8, I9, I10, I13.

DirectoryInbox owns string identities, schema-validated entries, atomic claims, leases, retry
and terminal receipts. Programmatic accept stores a versioned envelope with source/key and
payload before acknowledgement. A digest names the file; it is not a protocol sequence number.
Bot update_id ordering and MTProto gap recovery retain their own transport owners. No second
queue or numeric hash projection is introduced.

The StateStore transition owns one protected critical section. Its context asserts the held
storage generation before mutations and commit; an escaped context no longer owns that
section. FileStateStore uses the canonical exclusive lock. A delayed live process does not
lose ownership merely because a clock advanced. An unreadable or unattributable owner is
not proof that a process is dead. A readable legacy owner record is preserved without
inventing a machine or process lifetime.

Leases renew and settle only under their current generation. Receipt publication and file
removal share that protection, so an old handler cannot settle a newer claim or delete a
new accepted entry. Losing ownership aborts the handler and leaves its unconfirmed entry
recoverable. Capacity, payload bytes, attempts and deduplication retention are finite.
Retained receipts establish a bounded deduplication window, not perpetual uniqueness.

External sends have explicit outcomes. A transport may declare a refusal before the effect,
a permanent refusal, or an ambiguous result. Ambiguous delivery becomes durable uncertain
state and is not blindly sent again on resume. A provider wait is honoured within the
configured bound; exceeding that bound halts work rather than shortening the wait. Known
Bot API classifications remain the default adapter, and another SDK injects its own policy
into the same broadcast runner.

Application-owned clients compose through defineManagedResource, dependency values and
admission. Startup rollback, close and force share one destroy promise per generation.
A specific SDK helper is unnecessary when those existing contracts express the lifecycle.
Sessions, accounts, caches and transport recovery remain application policy.

These are evolving application and Telegram APIs. Source changes have explicit migration;
qualification includes restart, concurrent claims, paused/live lock holders, lease loss,
unknown sends and installed peer-free compositions. External effects remain at least once:
a local receipt cannot atomically prove a remote side effect.
