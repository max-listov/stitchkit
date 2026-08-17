---
title: "ADR 0077 — An error definition carries its default message"
description: A domain error's human-readable text is declared once beside its status, and the model-facing tool envelope deliberately does not carry it.
type: decision
status: accepted
created: 2026-08-17
updated: 2026-08-17
---

# ADR 0077 — An error definition carries its default message

- **Status:** Accepted — extends
  [ADR 0058](0058-zod-first-domain-error-definitions.md)
- **Date:** 2026-08-17

## Context

ADR 0058 fixed the shape of a domain error definition as `{ status, details? }`.
The human-readable text was left to the call site: `errors.X({ message: '…' })`,
with `AppError` falling back to the code itself.

Two things followed. Applications keep a separate `code → message` dictionary
next to the registry — the second source of truth the registry was meant to
remove. And the field was already accepted in practice: excess-property checking
does not fire through a `const` generic, so `defineErrors({ X: { status: 404,
message: '…' } })` compiled, the key was frozen into `definitions`, and the
factory ignored it. A field that can be written, looks right and silently does
nothing is worse than an absent one.

## Decision

`ErrorDefinition` accepts an optional `message`. Precedence is per-call →
declared → the code (the pre-existing fallback, unchanged for registries that
declare nothing). An empty or whitespace-only declared message throws when the
registry is declared, mirroring the status validation.

`FrozenErrorDefinitions` normalises the optional key. Without that,
`const` inference keeps only the keys each definition actually wrote, so a
registry mixing codes with and without `message` has no common key and
`definitions[code].message` — the lookup by a `code: string` variable, which is
the whole point of declaring the text — does not type-check.

`hint` is deliberately **not** added. Tool mounts concatenate a per-error hint
with the surface-wide `ErrorHintFn`, so a declared default would append itself to
every instance of that code and duplicate the advice.

## Consequences

- One declaration carries code, status, message and details schema. A consuming
  application no longer needs a parallel message map.
- **The model-facing tool envelope keeps its shape and gains no `message`
  field.** It stays `{ error, details?, _hint? }`; changing it would be a
  breaking transport change and is a separate decision. But the envelope is not
  unaffected: for a code that declares **no** details schema the framework
  already fills `details` with `{ message }`, so such a code now shows the model
  the declared text where it used to show the code. A code that declares a
  details schema shows the model no text at all. Both halves are tabulated in
  the guide and pinned by tests, rather than flattened into "the model does not
  see it".
- A registry that already carried a string `message` (accepted, ignored) changes
  behaviour: that text now reaches the wire in place of the code — on HTTP, and
  on the tool path for codes without a details schema. The class is narrow, but
  it is a behaviour change and is listed as breaking rather than shipped
  silently.
- Registries that declare no `message` are byte-for-byte unchanged.
