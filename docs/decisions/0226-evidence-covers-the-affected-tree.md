---
title: Evidence covers the affected tree
description: Publication intent cannot narrow evidence for code included in the same SHA.
status: active
type: decision
created: 2026-10-03 13:30 +07:00
updated: 2026-10-03 13:30 +07:00
---
# Evidence covers the affected tree

**Invariant:** P.

## Context

A release train identifies packages to publish. Its SHA can also include edits to other
packages, shared tooling, hooks or workflows. Selecting evidence from publication intent
alone leaves those edits unqualified even though they are part of the published tree.
A successful skipped job is not evidence that its required lane ran.

## Decision

CI evidence is the union of the release train, affected package paths and shared inputs.
Shared tooling, root manifests, the lockfile, hooks and workflows require all package
lanes. Train metadata alone does not broaden publication or evidence. A push uses the
entire before-to-head range; a new branch uses the complete tree. Publication continues
to use only the train.

The planner emits a validated, internally consistent plan. Artifact assembly and final
CI status use the same predicate over named job results. Required jobs must succeed;
unselected jobs may succeed or be skipped; failed or cancelled jobs are refused. Repository checks and the planner are always required.
Starter target and HEAD modes are both required when both contracts are affected.
Darwin and starter matrix jobs contribute their aggregate result after every selected cell.

Both tag entrypoints validate every selected package and require a successful push run
of ci.yml for the full SHA before creating the first tag. An unavailable API or a local
green memo cannot replace remote evidence. Publication independently checks the same
SHA and consumes immutable artifacts from that run.

## Alternatives

Selecting only the train is smaller but cannot prove cross-package edits. Running every
lane on every package-only change is safe but spends unrelated work. The union keeps
coverage complete while preserving meaningful package selection.

## Consequences

A single-package publication can require other package lanes. Structural workflow tests
exercise disabled jobs, missing dependencies, ignored failures and incomplete matrices;
planner tests exercise contradictory flags and complete push ranges. This is a coverage
contract, not an authorization to publish additional packages.
