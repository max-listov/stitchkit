# 0238 — Before 1.0 the shape of the API outranks compatibility

**Status:** Accepted
**Date:** 2026-10-05

Builds on ADR 0198 and ADR 0204. Invariants I8 and I14.

## Decision

Before 1.0, a change that makes a public call site clearer, smaller or harder to misuse is made
even when it breaks consumers. It is made as one clean cutover: the old shape is deleted, every
call site in the repository moves in the same change, and no alias, shim or deprecated twin stays
behind.

A break of this kind is never silent. It ships as a minor release with a `### ⚠️ Breaking changes`
entry that starts with the entrypoint, shows a before → after snippet and names who must act, and its
migration is written in `docs/guide/upgrading.md` as steps a consumer or an agent can apply
mechanically. The shape rules that guide such a change are in
[`docs/architecture/api-shape.md`](../architecture/api-shape.md).

Compatibility is not given up for taste. The change must remove a concrete defect of the call site:
a positional parameter list or boolean pair that cannot be read, two names for one concept, a type
that cannot be inferred where it is used, or a refusal whose reason a caller can only recover by
parsing text. A rename with no such defect is not a reason to break anyone.

## Reason and verification

Pre-1.0 consumers have opted into an evolving API and are migrated by explicit versions: the caret
range of a `0.x` release never crosses a breaking minor on a plain install. The cost of a clean
break is one mechanical migration, paid once. The cost of keeping a poor shape is paid at every call
site by every consumer and every agent that copies an example, and it is still there at 1.0.

Verification is the existing release gate: `scripts/release-plan.ts` refuses a breaking section
without its entrypoint prefix, its stable-entrypoint ADR where one applies and its promoted
migration, and refuses a breaking item in a patch version.
