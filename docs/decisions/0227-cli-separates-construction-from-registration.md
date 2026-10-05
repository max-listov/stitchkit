---
title: CLI separates construction from registration
description: Strict schema-aware runtime-tool construction and neutral heterogeneous registration keep optional SDK declarations outside CLI.
status: active
created: 2026-10-04 11:48 +07:00
updated: 2026-10-04 12:07 +07:00
type: decision
---

# CLI separates construction from registration

**Invariants:** I3, I7, I8, I14.

A CLI imports executable runtime-tool contracts without importing MCP or AI SDK declarations.
One neutral module owns identity, schema-derived input/output, handler context and void
construction. SDK definitions extend that contract with the exact presentation types of their
adapters; the CLI never interprets those presenters.

Construction and heterogeneous registration have different responsibilities. The generic
construction contract keeps a strict function-property handler so a callback requiring a field
absent from its schema is refused. The registration contract derives its fields from that owner
and accepts each concrete definition with handler(context: never). A registered handler cannot
be called directly through the erased type; the existing managed runner parses its input schema
before invocation. The generic collector retains the concrete definition subtype for SDK
presenters. No cast, copied SDK declaration, compatibility alias or second runner is needed.

Raw inline registry objects do not provide schema-aware construction. CLI consumers construct
with RuntimeToolExecutionWithOutput or RuntimeToolDefinitionWithoutOutput before registration;
shared SDK tools use defineRuntimeTool or createRuntimeToolFactory and pass the resulting value.
This source-type boundary is a marked stable-entrypoint break with a migration and a minor
release. Native CLI commands, invocation envelopes and runtime execution retain their behavior.

Qualification reads the packed artifact outside the author checkout. The neutral compiler uses
strict NodeNext, skipLibCheck: false and negative imports for absent SDK peers; the same imports
must refuse with unused-expect-error diagnostics when real SDK peers are installed. A sibling
SDK consumer checks precise construction, presenters and typed MCP input. Bun and Node execute
managed/native commands, reject invalid input before side effects and report a missing transport
peer explicitly. Publication verification keeps minimal and SDK installations as siblings so
one proof cannot borrow optional dependencies from the other.

See [CLI construction](../guide/cli.md#installation-and-types) and the
[migration](../guide/upgrading.md#released-migration-01040).
