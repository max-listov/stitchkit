---
title: CLI publication commits assets before the public pointer
description: A bounded opt-in publisher reuses CLI manifest, signatures, exclusive locking and atomic filesystem publication.
status: active
created: 2026-10-04 12:49 +07:00
updated: 2026-10-04 12:49 +07:00
type: decision
participants:
  - role: authored
    harness: Codex Desktop
    model: GPT-6
    at: 2026-10-04 12:49 +07:00
---

# CLI publication commits assets before the public pointer

**Invariants:** I8, I9, I10, I11, I13.

publishCli owns local asset publication; the application owns build orchestration, source
admission, version policy, addresses and deployment. The build receives one shared stamp and
returns bounded bytes or a stream. It does not receive an unrestricted destination path.
The publisher uses the existing CLI manifest and signature contracts, not a second schema.

A held canonical lock serializes cooperative publishers. Its generation is asserted before
promotion. Assets for every declared target are built and verified under finite raw and
compressed byte limits, then committed into an immutable version directory. The public
manifest changes last through durable atomic publication and readback. Before that step,
the existing manifest and assets remain available.

An existing version is verified against its identity, complete target set, layout, size,
digest and declared trust. A repeat keeps its bytes, commit and build time without invoking
the build. A complete version directory left before promotion is recovered by the same
verification. An application may explicitly select an older unchanged CLI identity for a
new backend release; it cannot label those existing bytes with the backend's new commit.

Storage reads are bounded and refuse unsafe paths, symbolic links and special files.
Retention and directory counts are finite; only verified publisher-owned versions may be
removed. A directory whose name looks like a version is not evidence of ownership. Runtime
and unrelated directories remain outside retention. Admission and cancellation are checked
again before the visible commit; a late callback cannot promote after its deadline.

The public pointer is a commit boundary. An error after atomic publication may mean the new
bytes are already visible. Such a refusal preserves publication state instead of promising
rollback or blindly performing the action again. The portable contract assumes a trusted
parent and cooperative writers; pathname checks are not a hostile-process atomic CAS.

Ed25519 signatures use the existing canonical signing payload. The updater proves trust and
the digest of decompressed executable bytes. The shell installer proves its declared digest
and size; it is not represented as verifying detached signatures. Qualification executes the
same manifest through installed Bun/Node consumers, actual installer/updater paths, repeated
publication, recovery and adversarial failure controls without a production rollout.
