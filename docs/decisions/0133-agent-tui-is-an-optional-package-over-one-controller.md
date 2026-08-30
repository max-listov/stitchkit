---
title: "ADR 0133: Agent TUI is an optional package over one controller"
description: "Terminal product mechanics live in stitchkit-tui while the headless runtime remains provider-neutral and owns the only execution loop."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0133 — Agent TUI is an optional package over one controller

## Context

The Agent starter proved a useful terminal session, but reusable product mechanics lived in copied
application source: transcript projection, scrolling, slash commands, model discovery, approvals,
conversation navigation and local attachment. Copying them makes fixes diverge and leaves no
canonical way for another local process to address the open terminal session.

The renderer still must not enter `stitchkit` core. Provider policy, tools, storage and isolation
also remain application choices. An external client must not acquire a second controller lease or
start another model loop beside the terminal host.

## Decision

Publish `stitchkit-tui` as an optional Bun/OpenTUI package. It consumes a typed
`defineAgentTui()` config and the existing headless harness. The application supplies the model
catalog, runtime bundle, context, tools and policy; the package supplies the terminal controller,
full transcript, multiline composer, commands, model/conversation pickers and presentation state.

The provider-neutral core owns model-catalog and per-conversation selection contracts. Provider
adapters may project popularity and benchmark observations, but keep those facts separate with
source and timestamp. A submitted run pins the selected model in durable input metadata, so later
selection changes and recovery cannot rewrite its identity.

One TUI process owns one controller. It publishes a mode-`0600` descriptor and authenticated Unix
socket. Local `status`, `send` and `interrupt` requests enter that controller; they never mount a
second runtime. Conversation listing is an optional reader capability on a store adapter, not a new
required method on every `AgentRuntimeStore` implementation.

Direct coding tools use operation names (`read_file`, `write_file`, `apply_patch`, `search_files`,
`run_command`, `read_output`, `read_resource`) rather than host-profile prefixes. Search skips
declared dependency/build directories and symlinks with bounded diagnostics; it does not fail a
whole workspace on the first ordinary dependency symlink.

## Consequences

- Headless users keep every existing composition path and install no renderer.
- Terminal hosts share one maintained interaction surface while retaining typed customization.
- Programmatic input can target the session already visible to a person without a competing lease.
- Model popularity is not presented as benchmark quality, and every observed fact declares age.
- The Agent starter shrinks to `stitchkit.agent.ts` plus host policy instead of forking the TUI.
- This supersedes ADR 0132's decision to keep the complete TUI implementation in the starter; the
  explicit Agent template itself remains accepted.
