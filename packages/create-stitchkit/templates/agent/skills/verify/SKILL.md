---
name: verify
description: Check a completed change with the project's own Bun scripts before reporting success.
---

# Verify

Read `package.json`, choose the narrowest relevant script, run it with the direct shell tool and
report the exact result. Use `bun run check` and `bun test` when the change affects shared types or
behavior. Do not invent a green result from code inspection alone.
