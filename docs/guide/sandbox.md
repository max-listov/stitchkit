---
title: Optional process sandbox
description: Linux namespace isolation, durable workspaces and a host credential gateway.
---

# Optional process sandbox

`stitchkit/agent-runtime/sandbox` is a server-only, evolving API. Existing coding
tools and agent configuration retain their current behavior. A host explicitly
creates a session and opts into `createSandboxCodingTools`; importing this
entrypoint does not redirect existing coding tools.

```ts
import { createBubblewrapSandboxBackend } from 'stitchkit/agent-runtime/sandbox';

const backend = await createBubblewrapSandboxBackend({
  stateDirectory: '/var/lib/my-app/sandboxes',
  maxConcurrentCommands: 8,
  onBrokerError: (cause) => console.error('Internal sandbox gateway error', cause),
});
const template = await backend.prewarm({
  template: 'agent-workspace',
  files: { 'hello.txt': new TextEncoder().encode('hello') },
});
const handle = await backend.create({ template: template.templateKey, network: 'deny-all' });
try {
  const result = await handle.session.run({ executable: '/usr/bin/cat', args: ['hello.txt'] });
  console.log(result.stdout);
  const state = handle.captureState(); // Persist this descriptor in the host's store.
  await handle.stop();
  const resumed = await backend.create({ template: template.templateKey, state, network: 'deny-all' });
  try { console.log(await resumed.session.readTextFile('hello.txt')); }
  finally { await resumed.delete(); }
} finally { await handle.shutdown(); }
```

`prewarm` snapshots the supplied byte files. Its content-addressed key includes
the backend name, template name and file contents. It is not a VM image or a
package installer. `stop` and `shutdown` kill live commands and retain workspace
files; `delete` removes session state and workspace, preserving reusable templates.
Reconnect requires the same backend name and template. A live owner holds an
exclusive lease: concurrent attach and deletion by an older handle fail with
`SANDBOX_BUSY`. After a host crash, an operator must verify that its processes are
gone before removing a stale lease; automatic crash recovery is not provided.
Storage is process-durable, without a power-loss/fsync guarantee.

## Coding tool integration

```ts
import { createSandboxCodingTools } from 'stitchkit/agent-runtime/sandbox';
import { mountAgent } from 'stitchkit/tools';

const tools = mountAgent([], {
  runtimeTools: createSandboxCodingTools(handle, {
    authorize: (operation) => applicationPolicy(operation),
    executables: { shell: '/usr/bin/sh' },
    requiredRestrictions: ['network-denied', 'write-contained', 'process-contained', 'secrets-hidden'],
    limits: { shellTimeoutMs: 10_000, maxShellOutputBytes: 65_536 },
  }),
});
```

The factory uses the existing coding profile, including its authorization,
path containment, UTF-8 handling, output artifacts and command limits. File tools
access the same workspace through the host's contained-file implementation;
commands run inside the namespace with `/workspace` as their root. The host-only
`handle.coding` binding never belongs in model input or persisted state.
Unsupported backends omit the binding and the factory refuses explicitly.

Stop also kills coding commands. Both launch paths share the configured
`maxConcurrentCommands` admission limit (default 8); an occupied slot gives
`SANDBOX_BUSY` before another process starts. This counts direct commands, not
guest descendants. Required restrictions are checked again during preparation;
a network-policy change invalidates an outstanding prepared launch. After
reconnect, create the coding profile from the new handle; old tools remain stopped.

## Network gateway

`deny-all` isolates the network namespace, including DNS and loopback access to
host services. `{ allow: [{ origin, headers }] }` retains that isolation and
allows HTTP through a Unix-socket gateway only. Origins are exact HTTP(S) origins,
including scheme and port; no wildcard, redirect, arbitrary TCP or CONNECT tunnel
is allowed. For HTTPS upstreams the **host** establishes TLS. Guests speak HTTP
over the socket with the upstream host in `Host`, for example:

```ts
await handle.session.setNetworkPolicy({
  allow: [{ origin: 'https://api.example.com', headers: { authorization: hostCredential } }],
});
await handle.session.run({
  executable: '/usr/bin/curl',
  args: ['--unix-socket', '/run/stitchkit-network.sock', 'http://api.example.com/resource'],
});
```

The host obtains `hostCredential` from its credential store. Headers never enter
guest environment, process arguments or persisted reconnect state. Authorized
upstreams are trusted: an upstream that reflects its request headers can disclose
them in its response. This gateway cannot prevent that. Header values are fixed
for the policy; replace the policy to rotate credentials. Policy changes require
all commands to finish or stop (`SANDBOX_BUSY` otherwise). `allow-all` explicitly
shares host networking and adds no injected headers; use it only when unrestricted
egress is intended. Policies are resupplied on every reconnect and are not stored.

## Runtime boundary

The reference backend requires Linux, `/usr/bin/bwrap`, usable namespaces and a
conventional `/usr`, `/lib`, `/lib64` layout. Failure to establish isolation gives
`SANDBOX_UNAVAILABLE`; there is no host-execution fallback. Runtime directories
are read-only, the workspace is writable, environment is cleared, and host home,
state storage and other host sockets are not mounted. Each command gets ephemeral
`/tmp`; only `/workspace` persists. Runtime binaries and the configured state
directory belong to the trusted host. See the
[Bubblewrap security model](https://github.com/containers/bubblewrap#system-security).

This is namespace isolation over the host kernel, not a VM. It does not impose
memory, CPU, disk or process-count quotas. A host running mutually untrusted workloads
must supply those bounds outside the namespace (for example, a delegated cgroup and
quota-controlled storage); command admission is not a substitute. Commands default to a 30-second deadline
and 1 MiB combined output; callers can configure both. File I/O is bounded to
1 MiB. The gateway allows 16 concurrent requests, 1 MiB request/response bodies
and a 30-second deadline. Do not treat these bounds as resource containment for
arbitrary hostile workloads.

Custom backends implement `SandboxDriver` byte I/O, `spawn` and policy enforcement;
`createSandboxSession` supplies text conversion, paths and `run` once. Paths are
workspace-relative or canonical `/workspace/...` paths. Unsupported policies must
be refused explicitly by the backend.
