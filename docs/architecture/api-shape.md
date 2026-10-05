---
title: API shape — how a stitchkit call site should read
description: The shape rules for public APIs, each with a before and an after, and the procedure for a breaking cutover that makes a call site clearer.
type: architecture
status: active
created: 2026-10-05
updated: 2026-10-05
---

# API shape — how a stitchkit call site should read

A public API is judged at the call site: someone reads one line of a consumer's code, or one
example in an agent's context, and must understand it without opening the definition. These rules
say what that looks like. The decision that lets a change break consumers to get there is
[ADR 0238](../decisions/0238-pre-1-0-api-shape-outranks-compatibility.md); the invariants are in
[`PRINCIPLES.md`](../PRINCIPLES.md).

## Test: read the call site aloud

If reading a call needs the signature open beside it, the shape is wrong. Every rule below is a way
of failing that test.

## Intent at the call site

**More than two positional parameters, or any boolean or `undefined` placeholder, becomes an options
object.** A position says nothing; a name says what it means.

```ts
// before: eight positions, two `undefined` in a row
throw new ApiError(code, 0, details, message, hint, undefined, undefined, retryable);

// after: each value names itself
throw new ApiError(code, { status: 0, details, message, hint, retryable });
```

**A boolean pair becomes a named mode.** Two booleans have four states and the reader must know which
one is meant; most of the four are not valid.

```ts
// before: what are `false` and `true`?
await publishAtomicFile(staged, target, false, true);

// after: the states that exist, by name
await publishAtomicFile(staged, target, { replace: false, durability: 'directory' });
```

## One name, one declaration

**One concept has one public name and one way to declare it.** Two families of types for the same
thing make a consumer choose by import path, and make an example copied from one place fail in
another. The adapter-specific part is an extension of the one declaration, not a second declaration.

```ts
// before: the type to write depends on which entrypoint you import from
const tool = { input, output, handler } satisfies RuntimeToolExecutionWithOutput<…>;
const tool = { input, output, handler } satisfies RuntimeMcpToolDefinitionWithOutput<…>;

// after: one declaration, and the handler is typed where it is written
runtimeTools: [defineRuntimeTool({ input, output, handler: ({ input }) => … })];
```

Inline use must infer. A declaration that only type-checks after a `satisfies` annotation, an
explicit generic or a cast has the wrong shape.

## No silent default for a decision

**A choice that changes what happens to someone's data or processes is explicit and has a named,
safe default, documented where it is defined** (I9). The option is load-bearing: a test proves it
changes behaviour.

```ts
// stopping what the leader left in its group is the default (`'terminate-after-leader'`);
// keeping it alive is a named choice
runNativeCommand({ ...spec, descendants: 'leave' });
```

## Refusals carry a reason, not a sentence

**A caller never parses a message.** Every error that a caller may branch on has a typed `reason` or
`code` from an exported union; the message is for people.

```ts
// before: telling "too large" from "not JSON" needs text matching
catch (error) { if (String(error).includes('bytes')) … }

// after: a reason a caller can switch on
catch (error) { if (error instanceof CanonicalJsonError && error.reason === 'bytes') … }
```

Do not leak the cause outward (I13): the safe error carries the status and a stable code; the raw
upstream body stays in `cause`.

## Output says only what was declared

Help, errors, listings and generated docs show what the author declared. Implementation limits that
the author never wrote (a default integer range, an internal ceiling) are noise and are not printed.
A listing's order is the order of declaration, because it often encodes priority.

## Every export explains itself in one line

Every exported name of a public entrypoint has a one-line JSDoc in plain words: what it is and the one
thing a caller must know. That line is what an agent reads in `llms/<entrypoint>.txt`. A guide page
opens with the shortest working example, then the reasoning. Docs and comments state how it works now
and why, never the history of the edit.

## A breaking cutover that earns its keep

A change that fixes one of the defects above is a clean cutover:

1. Delete the old shape; move every call site in the repository in the same change. No alias, no
   deprecated twin, no compatibility overload (I8).
2. Write the entry under `### ⚠️ Breaking changes` in `CHANGELOG.md`: the backticked entrypoint, what
   changed, a before → after snippet, and `**Who must act:**`.
3. Write the migration in `docs/guide/upgrading.md` as mechanical steps, ideally one search pattern
   and one replacement per step.
4. Ship it as a minor (pre-1.0). A patch never carries a break.
5. Add the test that fails on the old shape.

A rename with no concrete defect behind it is not a reason to break consumers.
