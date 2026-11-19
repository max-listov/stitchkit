---
title: "ADR 0296: Framework options reserve their CLI spellings"
description: A leading framework flag selects the same grammar before discovery, and older flag-named commands cannot silently redirect execution.
type: decision
status: accepted
created: 2026-11-20 04:23 +08:00
updated: 2026-11-20 04:23 +08:00
---

# ADR 0296 — Framework options reserve their CLI spellings

Amends shell routing in [ADR 0083](0083-cli-composes-managed-and-native-commands.md). Serves **I8** and **I9**.

## Context

In a CLI without a default command, `app --quiet inspect` could invoke a
command literally named `--quiet` with the positional argument `inspect`.
With leading framework flags the same text requests `inspect` in quiet mode.
Both handlers can succeed, so exit status alone cannot reveal the change.
Looking up the first token in a dynamic catalogue would make native commands
depend on credentials and make the standalone argv router depend on discovery.

## Decision

The shell reserves framework options, their inline forms, the argument
separator and built-in help and version tokens. The router can recognise these
from argv alone. A matching native or statically declared CLI command raises
a configuration error before dispatch. A managed factory raises that error
when its catalogue is loaded. Direct, already-parsed in-process invocations
have an explicit operation name and no flag position.

One earlier invocation cannot be interpreted safely offline. If the CLI has
no default command and a managed factory, a leading framework option before a
native name might previously have selected an operation from that factory.
The shell refuses this order with exit code 2 before loading credentials or
calling either handler. Command-first syntax, such as `app inspect --quiet`,
selects the native handler offline. With a default command, the earlier grammar
already interpreted the prefix as options.
