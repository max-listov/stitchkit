# Upgrading stitchkit-tui

## Released migration: 0.2.0

### stitchkit is a peer

**Who must act:** projects that install `stitchkit-tui` without listing `stitchkit` themselves.

`stitchkit-tui` no longer installs the framework for you: add `stitchkit` to your own
`dependencies`, in the range the new `stitchkit-tui` declares as its peer (`bun info
stitchkit-tui peerDependencies`). Remove any `overrides` entry that forced a single stitchkit copy —
the peer makes it unnecessary.

## Released migration: 0.1.0

Initial release. Existing headless runtime compositions remain valid; adopting the terminal host
is optional.
