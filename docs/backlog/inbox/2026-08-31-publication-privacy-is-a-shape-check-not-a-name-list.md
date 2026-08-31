---
title: Publication privacy is checked by shape, not by a list of names
description: Anonymisation at write time holds today, but nothing enforces it. A form-based gate over the tree and the packed artifact turns that discipline into a check without publishing a registry of the names it protects.
type: task
status: inbox
created: 2026-08-31
---

## Зачем

This repository is public and its boundary is anonymisation **at write time**:
consumer pain is written as a reproducible technical case, never as "project X
asked for it". Measured today across `docs/`, `packages/`, `scripts/` and the
root markdown: zero occurrences of any private fleet project name. 481 closed
tasks disclose nothing, because by construction there is nothing in them to
disclose.

The weakness is not the boundary, it is that **nothing enforces it**. One
inattentive writer reintroduces a name and no gate notices.

The obvious fix is wrong. A gate that greps for a list of private project names
would have to keep that list in the public repository — publishing exactly what
it protects.

## Результат

A gate that checks **forms**, knowing no names:

- agent/session routing markers (`^responsible:`, `^target-repo:`, session
  vocabulary);
- non-public home paths — `/home/<x>/`, `/Users/<x>/` — with a whitelist of
  synthetic users used in fixtures;
- fleet node identity — `NAME-DEV`, `NAME-PROD`, `NAME-STAGING` and the like;
- credentials in URLs (`scheme://user:pass@`), with an explicit example
  whitelist.

Findings carry file/line/rule. A second layer runs the same scan over the
**unpacked published artifact** (`bun pm pack` → extract → scan), which catches
"the tree is clean but the tarball is not".

The value is that no registry of secrets is needed: the node-identity pattern
catches a machine that does not exist yet, and the home-path pattern catches a
project created tomorrow.

## What it deliberately does not catch

A private project named in prose with no path and no capitals. Only write-time
discipline covers that; the gate insures from the other side rather than
replacing it.

## Источник

A working implementation exists in a sibling private repository
(`scripts/publication-privacy.ts`, ~118 lines, plus a ~207-line packed-artifact
test layer). It is generic and was offered for direct reuse; adopt it rather
than re-deriving the patterns.
