---
title: "ADR 0285: Search bounds the work before reading"
description: One glob automaton prunes descriptor-relative traversal; search streams files under finite work and output budgets with explicit coverage.
type: decision
status: accepted
created: 2026-11-09 12:47 +07:00
updated: 2026-11-09 21:36 +07:00
---

# ADR 0285 — Search bounds the work before reading

Serves **I8**, **I10**, **I12**, **I13**.

## Decision

The workspace glob is one finite automaton for full-file matching and directory-prefix
reachability. Its grammar is `**`, `*`, `?`, literal punctuation and anchored UTF-16 matching.
Directory prefixes that cannot lead to a match are excluded before host policy or opening;
`**/docs/**` necessarily keeps arbitrary ancestors because a later descendant may be `docs`.
There is no competing matcher and no recursive-regex backtracking in glob evaluation.

The existing descriptor-relative walker serves strict resource discovery and coding tools.
Search consumes a file through a visitor before opening another, so total retained content
is bounded by one file. Host authorization precedes every admitted path open; nofollow opens
remain attached to pinned directory identities. The selected root capability is pinned before
operation and path policies and retained across replacement of a configured alias or the root name itself.
Excluded paths are outside the requested scope. Callback and cleanup failures propagate to error
hooks; only failures at a filesystem operation become diagnostics naming that operation.

List, glob and search use the same coverage contract and finite directory-open, enumerated-entry, total-content-byte, file/depth/result,
per-file-read, deadline and serialized-result budgets. Canonical spelling checks use that same
budget and bounded enumeration; an incomplete check never claims a spelling is absent. List also
caps raw entries at maxListEntries, before materialization; glob input is capped at 4,096 units. Linux enumerates through a descriptor
path with a one-entry directory buffer; Darwin caps its native descriptor reader before
materializing entries. Bounded entries are sorted after enumeration. No entry or match is
read past its ceiling merely to establish that another exists: equality is conservatively partial.
Content bytes consumed by failed decoding count against the same shared allowance; allocation
and chunk reads stay within the remaining file and aggregate allowances.

The caller signal and deadline use the shared deadline/race primitives. CPU checkpoints detect
expiry inside glob-state work and between bounded comparisons; asynchronous policy and I/O waits
race cancellation. Directory readers check inside their enumeration loops before starting a new
read and after the active read settles, so cancelling a wait also stops its producer.
Late file/directory capabilities close when they arrive. An operating-system call already in
flight may finish later; no user-space timer is described as interrupting the kernel.

Search regex keeps JavaScript `RegExp` syntax and semantics without flags. Each line is run by
the native engine when its backtracking work stays within 2^24 steps: every start position walks
each path through the alternatives once, and on a line of L units no repetition iterates more
than L times beyond its required iterations — a body that can match empty still runs all of
those, one that cannot never reaches more than L — so the unrolled pattern with repetition capped
that way, paths × the longest path × L, bounds the line, measured once per power-of-two length.
The engine may also enter, leave and save every group a step lies in — the enclosing groups and,
inside a repeated body, every group of that body — so that bound is multiplied by the pattern's
number of groups plus one, which bounds both nesting depth and body width.
An iteration that consumes nothing still costs a step, so nested repetition of
an empty group is never a native line. Content matching yields to the event loop every 16 ms of
CPU, so a caller's abort arrives between lines of one file. An alternation of single units no
two of which accept the same unit leaves
one way forward per position and counts as one path, like the class it spells. The engine itself
stops after 100,000,000 counted operations per call and then answers no match; one step of the
model costs it about two, so 2^24 keeps a threefold margin and a native line never ends in a
silent false. One uninterruptible native
line therefore overshoots the deadline by a fraction of a second at most, and ordinary `.*`
searches over code lines keep native speed. Every other line is run by a linear automaton
rather than the backtracking engine: a deadline checked between lines cannot bound one uninterruptible backtracking match, and
a denylist of constructs cannot make native matching linear.

Groups, alternation, classes, anchors, word boundaries and quantifiers compile into states;
matching walks the line once through lazily cached deterministic transitions keyed by unit class,
the cache is flushed past 4,096 states or 65,536 transitions; after two such flushes the state
sets do not repeat (a counted gap after a frequent unit) and the matcher simulates the automaton
directly, without interning. The deadline is checked inside that walk and during construction. Literals, single-unit escapes and bracket classes — escapes
inside them included, `\d`/`\w`/`\s` read from the engine once — are exact unit ranges, each class checked against the engine at every range boundary and midpoint; under `i` literals and class members fold by ECMAScript Canonicalize, with every folded pair
confirmed by the engine's own case tables and a class negated after folding. One sort of the
range endpoints splits the alphabet into segments, so thousands of such atoms cost their
endpoints rather than atoms × units, and memberships past 4,194,304 refuse. Dot and class escapes outside a class are the
same ranges (`[^\n\r\u2028\u2029]`, `[\s\S]` under `s`, `[\d]` and so on). Only a class the
engine check sends back stays a native one-character expression, evaluated once per distinct
unit into a fixed bit set; more than 64 such classes refuse, so their work never exceeds
64 × 65,536 evaluations whatever family of syntax produces them. A unit class is a segment plus the native answers and the assertion kind. The
restart of the unanchored search is one start closure per assertion context, kept outside the
deterministic states, so a pattern that fans out to thousands of alternatives does not copy that
fan-out into each state. Backreferences, lookaround, counted repetition above 1,000, automata
above 16,384 states and constructions above 65,536 steps refuse before authorization or
filesystem access.

`coverage` identifies scope, completeness, reasons and observed directory/entry/read-byte/time
counters. Unreadable paths return only relative path, operation and safe code; host errors are
not relabeled as symlinks. A complete empty result differs from zero reached files in a partial
scan. The UTF-8 byte ceiling covers the complete JSON, including escaping, context and diagnostics;
the minimum input-specific envelope is checked before I/O and all retained lists fit it.
Diagnostic admission measures each retained item once; finalization checks the deadline even when
there are no diagnostic items. Repeatedly serializing an entire shrinking list is not bounded work.

## Verification

Mounted public coding-tool tests exercise pruning, each budget, cancellation, stalled host
authorization, denied ancestors, real permission failures, UTF-8 rejection, output escaping
and symlink substitution, for concrete roots and configured aliases and both policy callbacks.
Discovery regressions include folded-name spelling checks, stalled policy cancellation and output bounds. Descriptor-backed read errors exercise the same walker separately.
Differential tests compare the automaton with the established glob grammar and require viable
ancestors of every matching path to remain reachable. Strict harness discovery still refuses
symlinks and exhausted bounds.
