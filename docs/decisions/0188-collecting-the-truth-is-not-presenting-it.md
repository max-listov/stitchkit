# 0188 — Collecting the truth is not presenting it

**Status:** Accepted
**Date:** 2026-09-22

## Context

0.90.8 fixed a refusal that said nothing. Zod reports a failed `z.union` as one
issue — code `invalid_union`, path `(root)`, message `Invalid input` — with every
per-branch reason it computed sitting unused in `issue.errors`. The fix descended
into those branches, so the projection carried the real path and one addressable
issue per branch. Two agents had spent an evening on one such refusal; the
changelog line said the refusal now names the branch and the field.

One release later a consuming session spent an hour on the same refusal. The
cause was named precisely and was inside the error the whole time:
`nodes.0.streams`, an optional field left `undefined`, rejected by `z.json()` on
a live object (over HTTP the key disappears in serialization, so the same payload
validated — which is why it was hunted in the wrong place).

Measured on the shipped code rather than assumed: the path **was** there. It was
the eighteenth of nineteen entries. `formatZodError` prints the first five
entries of a tree walk, and for a union over primitives the first entries are the
branches that failed on the type of the whole value — all at the union's own
path, all saying the same thing in different words. The reader got `(root)` five
times and `...and 14 more issues`.

Two smaller instances of the same shape sat beside it. `unionSummary` described
each branch by `issues[0]`, which for a nested union is that nested
`invalid_union` at the parent's own path — so the summary line for the branch
that descended furthest repeated what the reader already knew. And the depth
limit that bounds expansion also silenced the wording, so the one line that did
name the field read `nodes.0.streams: Invalid input`.

## Decision

The text projection and the structured projection have different jobs, and the
code now says so.

- A union branch is described by the **deepest named field it reached**, not by
  its first issue.
- When a union's summary must truncate, it keeps the branches that got
  **furthest**, not the first few.
- The text projection prints the first line at each path and drops repeats: the
  union's own line already quotes those reasons, and each repeat spends one of
  the few slots the cap allows.
- The depth limit bounds how many **issues** a nested union contributes. It does
  not bound what its own line is allowed to say: a capped union still gets a
  summary naming the deepest field it can reach.
- `zodIssues` and the envelope's `details.issues` keep every branch, repeats
  included. A machine addresses them by branch number and wants all of them.
- `path` is not redirected to the deepest field. The reporting session proposed
  exactly that — take the deepest path instead of `issues[0].path` — and it is
  refused as a formulation while its effect is delivered. The union really is at
  the root; a `path` that names somewhere else would be a second false statement
  to fix the first. The deep path is its own issue, and now also the first thing
  the message says.

## Consequences

The lesson is not about unions. It is that a projection with a cap is a
**presentation**, and a presentation that collects the right answer and then
truncates it to noise has not fixed the refusal — it has moved the defect one
layer out, where it is harder to see, because the data now contains the answer
and every test asserting the answer's presence passes.

This is the same class the reporting session named in three unrelated places
that day: an empty journal file instead of "I cannot speak", "zero rows" instead
of "not looked at", "unavailable" instead of "the service is not declared". A
system presenting something that reads like a fact when there is no fact. Ours
was the cheapest to fix and the easiest to miss, because it was green.

So the rule that earns its keep: when a refusal is fixed, read what a person
actually receives — the first line, at the cap, on the real payload — not the
structure the fix produced.
