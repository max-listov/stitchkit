---
title: Contained coding files and harness resources fail on macOS
description: Restore safe macOS file operations without treating dev-fd paths as traversable directory capabilities or weakening containment.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: P1
related: ../done/2026-08-30-coding-file-parent-swap-containment.md
---

## Why

Published `stitchkit@0.70.0` declares macOS support for descriptor-relative contained file
operations, but ordinary authorized calls fail before any race is introduced. This blocks a
managed headless coding harness on a platform explicitly named as supported. Do not restore the
mutable path-spelling implementation: the parent-swap security fix must remain effective.

Exact source: `d2478418469ae8ebb8dfce195e621c637422d178`.
Registry archive: 742535 bytes, SHA-256
`55b0f80d7672df604da0468fec387eeed70b75e3e408e535f90e8072d7b05f4f`.
Integrity:
`sha512-2aVY8ZlqVqRnw6tmJkavFRgFQJ2Qq+IZqygFwCqgyksD7232jQEZmoJ7r8dZBDL/XS55Nc1ftKAQdbH3WldNVQ==`.

## Reproduced boundary

Fresh isolated consumers use the registry artifact and its documented peers: `ai@7.0.85`,
`zod@4.4.3`, `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/ext-apps@1.7.5`.
No application service, user conversation, credentials or existing file is involved.

| Runtime | Ordinary absolute-path read | Descriptor child read | Public file operations |
| --- | --- | --- | --- |
| macOS 26.6.2 arm64 / Bun 1.3.14 | passes | ENOENT | root/nested read, write, patch, search and resources fail |
| macOS 26.6.2 arm64 / Node 26.7.0 | passes | ENOENT | same operations fail |
| Linux / Bun 1.3.14 | passes | passes | all nine platform assertions pass |
| Linux / Node 24.18.0 | passes | passes | all nine platform assertions pass |

On macOS Bun, `realpath('/dev/fd/<fd>')` resolves to the expected directory, but opening a child
beneath that spelling returns ENOENT and `readdir('/dev/fd/<fd>')` returns ENOTDIR. On macOS Node,
the current realpath identity check rejects the directory before those operations. An open
directory handle and a successful realpath check do not prove path traversal through `/dev/fd`.

`packages/core/src/agent-runtime/contained-files.ts` selects `/dev/fd/<fd>` for Darwin and FreeBSD,
then uses `path.join(descriptorPath(handle), segment)` and `readdir(descriptorPath(handle))` as if
the platform implemented Linux `/proc/self/fd` directory traversal semantics. FreeBSD is not
qualified by these observations and must not be claimed tested.

## Minimal reproduction

Run this module in a peer-complete consumer with Bun and Node on macOS. The first read succeeds;
the public `read_file` rejects. Repeat with `file.txt` directly under the root: it also fails.

```js
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { mountAgent } from 'stitchkit/tools';

const root = await mkdtemp(join(tmpdir(), 'contained-platform-'));
try {
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'file.txt'), 'fixture');
  console.log(await readFile(join(root, 'nested', 'file.txt'), 'utf8'));
  let authorizations = 0;
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root, authorize: () => { authorizations += 1; return true; },
    }),
  });
  const execute = tools.read_file?.execute;
  if (!execute) throw new Error('Missing public read_file');
  await execute({ path: 'nested/file.txt' }, {
    toolCallId: 'platform-probe', messages: [], context: undefined,
  });
  console.log({ authorizations });
} finally {
  await rm(root, { recursive: true, force: true });
}
```

Public failures are correctly generic `AgentToolError` rejections. Internal evidence on Bun is
ENOENT for child/file opens and ENOTDIR for search/resource scans; on Node it is
`Contained directory identity changed while opening`. This is a filesystem backend regression,
not an error-envelope regression or missing authorization.

The same published artifact passes the deterministic parent-swap read/patch refusals and typed
stale-digest CONFLICT on Linux. Its cancellation probe also passes on macOS and Linux: no child
alive at return and no delayed fixture effect. Those fixes must remain in the next artifact.

## Result and plan

- [ ] Provide a supported macOS native directory/file-handle containment mechanism for the public
      file tools and harness resource reader. Do not add a consumer-local filesystem engine or
      unsafe path fallback. An explicit unsupported-platform result is honest but does not
      satisfy the required macOS coding harness behavior.
- [ ] Prove positive root/nested read, create/overwrite, guarded patch, search and lazy/eager
      file-resource discovery on real macOS under Bun and Node.
- [ ] Keep root, ancestor and final-file identity bound across asynchronous authorization and
      effects; reject parent replacement and same-content outside-target races without escape.
- [ ] Preserve existing Linux positive/adversarial behavior, bounded file handles, private causes
      and generic outward errors. Verify any other claimed platform rather than inferring support.
- [ ] Add a real macOS CI/packed-consumer lane; Linux-only tests cannot qualify a Darwin branch.
- [ ] Publish the corrected artifact after full gates and exact-SHA CI; record version, source,
      archive digest and actual platform evidence. Update platform guidance and release notes.

## Acceptance

- [ ] The reproduction succeeds on macOS Bun and Node, with authorization actually reached.
- [ ] Real file/search/resource operations pass in both published-package consumers without shell
      wrappers, source imports or weakened containment.
- [ ] Deterministic authorization-barrier read/patch races cannot read or modify an outside fixture.
- [ ] Cancellation still prevents descendant effects; mounted failures remain failures through
      the canonical durable loop and legitimate successful error-shaped data remains successful.
- [ ] Published package and source references are exact; remaining platform limits are explicit.
