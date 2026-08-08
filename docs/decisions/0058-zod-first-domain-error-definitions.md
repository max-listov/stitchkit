---
title: "ADR 0058 — Zod-first domain error definitions"
description: Domain error factories construct literal-code AppErrors from immutable status and details-schema definitions.
type: decision
status: accepted
created: 2026-08-08
updated: 2026-08-08
---

# ADR 0058 — Zod-first domain error definitions

- **Status:** Accepted — extends the domain-free error boundary of
  [ADR 0002](0002-generic-core.md), the published framework-code registry of
  [ADR 0026](0026-stitch-error-code-registry.md), and cross-chunk branding from
  [ADR 0032](0032-apperror-brand-identity.md)
- **Date:** 2026-08-08

## Context

A numeric `CODE → status` table can generate a thrower, but cannot describe the
structured details allowed by each code. Positional message/details/hint
arguments also erase that distinction and force construction and throwing into
one action. Applications then duplicate the registry in a subclass, status map
and runtime validator.

## Decision

`defineErrors` accepts one immutable definition per application-owned code:
`{ status, details? }`. `details` is a required or optional Zod object. The
definition derives all public artifacts:

- a literal code table and guard;
- a frozen definitions/status registry;
- one options-object factory per code;
- forbidden, required or optional details at compile time;
- parsed structured details at runtime.

Factories construct branded generic `AppError` instances and never throw by
themselves. The call site uses ordinary `throw` or passes/inspects the instance.
HTTP and tool adapters keep their established envelopes; the factory does not
choose serialization policy.

## Alternatives rejected

- **Keep positional overloads.** They preserve ambiguity and cannot express
  per-code details without a parallel type map.
- **Add `defineErrorsV2`.** Two vocabularies would drift and leave every guide
  and consumer with a choice that has no semantic value.
- **Accept arbitrary details schemas.** Error details are structured objects;
  scalars and arrays weaken diagnostics and envelope consistency.
- **Throw inside the generated function.** Construction, composition and
  inspection remain impossible, and the helper behaves unlike an error class.

## Consequences

- One application registry replaces custom subclasses and copied status maps.
- Invalid details fail at construction, before transport normalization.
- Codes without schemas cannot silently acquire ad-hoc details.
- The redesign is breaking: numeric definitions and positional throwers have no
  compatibility overload.
