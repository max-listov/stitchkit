---
title: "Tool hooks take one options object"
description: afterToolCall reached seven positional parameters in 0.32.0 and the three tool hooks now disagree on shape — a breaking cleanup that needs a go/no-go before it is worth planning.
type: task
status: inbox
created: 2026-08-06
updated: 2026-08-06
related: docs/decisions/0042-the-audit-row-may-name-the-cause.md
---

# Tool hooks take one options object

**Needs a decision before it is worked on** — it breaks every consumer's hook.
Recorded in ADR 0042's consequences and deliberately not taken there, so that
it is judged on its own merits instead of riding along with a field.

## Why it comes up

`afterToolCall` grew to seven positional parameters in 0.32.0:

```ts
(toolName, args, result, durationMs, context, endpoint, error?) => void
```

Each addition was individually correct and additive. The sum is a signature
where the reader counts commas, and where a consumer who wants only the seventh
argument must name six placeholders to reach it — the `_n, _a, _r, _d, _c, _e`
prefix already appears in this repo's own tests.

The three tool hooks now also disagree with each other: `beforeToolCall` takes
four, `onToolError` four, `afterToolCall` seven. Nothing about the domain
explains the difference; it is the order they were written in.

## The shape

One object per hook, same key names across all three so a reader learns them
once:

```ts
// before
afterToolCall: (toolName, args, result, durationMs, context, endpoint, error) => { … }

// after
afterToolCall: ({ toolName, args, result, durationMs, context, endpoint, error }) => { … }
```

Every future field is then additive forever, which is the actual prize: this is
the second time in one day a hook needed one more piece of information, and
there is no reason to expect a third not to come.

## Cost, stated honestly

Breaking for every consumer that writes any tool hook — mechanical, but it is
their code, not ours. In this repo it also touches `createAuditHook`,
`createToolLogger` and their tests.

Per the project's rule, breaking is allowed and must never be silent: a
`### ⚠️ Breaking changes` section leading the version, before → after for each
of the three hooks, a minor bump, no compatibility shim, and consumers this
repo's owner controls updated in the same pass.

If we do it, **all three hooks at once**. Converting only `afterToolCall`
because it is the one that hurts would leave the interface with two styles and
guarantee this note is written a third time.

## The counter-argument

Three consuming projects are mid-migration right now — one of them is sixteen
minors behind. Every break spends goodwill and adds a step to migrations already
queued. The seven parameters are ugly, not broken; nobody has reported being
hurt by them, whereas everything shipped today came from a report.

So the question for the decision is not "is the object nicer" — it is — but
**"is now the moment to spend a break on aesthetics, or does this ride with the
next change that needs a break anyway?"** The second reading is defensible and
is the reason this sits in `inbox` rather than `planned`.

## If it is a yes

- [ ] All three hooks converted in one pass, shared key names
- [ ] `createAuditHook`, `createToolLogger` and every test updated
- [ ] `### ⚠️ Breaking changes` with before → after for each hook
- [ ] `docs/guide/observability.md`, `docs/api/reference.md`, the JSDoc on each
      hook
- [ ] The three consuming projects' migration tasks updated in the same pass
- [ ] ADR — one decision record covering the shape and the "all three at once"
      rule, so a fourth hook is born in the right form
