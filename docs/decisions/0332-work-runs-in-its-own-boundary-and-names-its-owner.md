---
title: "ADR 0332: Launched work runs in its own boundary and names its owner"
description: "`stitchkit/service-host/work` places a launched command in a transient systemd scope or under a recorded process root, declares a typed owner record, and carries one inherited variable that names the boundary; only the boundary proves membership."
type: decision
status: accepted
amends: ["0255"]
created: 2026-11-27
updated: 2026-11-27
---

# ADR 0332: Launched work runs in its own boundary and names its owner

**Relations:** Extends [ADR 0309](0309-service-host-supervision-primitives.md) (service-host primitives) and builds on [ADR 0243](0243-a-command-stops-by-one-named-policy.md) and [ADR 0246](0246-a-command-stops-its-descendants-by-default.md) (what a process group does and does not hold); amends [ADR 0255](0255-an-owner-loss-guard-belongs-to-the-command-group.md) (the bundled bootstrap serves every package-owned invocation and is renamed). Serves **I4**, **I8**, **I9**, **I10**, **I11**, **I12**, **I13** and **I14**.

## Context

A machine that runs many launchers — a session host, a release runner, a remote login — showed
its operator one service with a hundred processes, an unnamed `bun` in a scope with a generated
name, and nothing that said who started which. Each launcher that did draw a boundary drew its
own: its own unit name, its own variable, its own rule for believing it. Three launchers meant
three implementations and three record formats, and a monitor had to learn each.

Measurements on a Linux host with systemd 259 and cgroup v2 decided the shape:

- A process group is not the boundary. A descendant that calls `setsid` leaves the group and the
  session and keeps running; its control group does not change. A transient scope still holds it.
- `systemd-run --scope` execs the command: the pid that was started is the command's pid, and its
  start time in `/proc/<pid>/stat` is unchanged by the exec.
- `systemd-run` expands `${VAR}` and `$$` in the command's arguments, with `--scope` too, unless
  it is given `--expand-environment=no`; systemd-run(1) records that option as added in version
  254. An argument `${HOME}` arrived as the caller's home and `$$` as `$`.
- A unit name that is still loaded is refused; a scope run with `--collect` frees its name once
  it is empty.
- A session host starts its sessions through a terminal multiplexer, so the sessions are not its
  children: an API that can only spawn a child cannot place them.

## Decision

1. **One evolving entrypoint owns it: `stitchkit/service-host/work`.** systemd is known only to
   the service-host part; `stitchkit/process` stays the owner of finite commands and learns
   nothing about the host manager. The command itself still runs through the one native-command
   owner.
2. **The owner record is a schema with no optional field.** `WorkOwnerSchema` holds the launcher's
   name, its id of the work, a label, and `project`, `agent` and `parent`, each of which is a
   value or an explicit `null`. Launcher, project and agent are bounded free strings: the package
   keeps no list of launchers. The record is the launcher's to store and serve; the package gives
   the schema, never a registry.
3. **Placement is always written out.** `{ kind: 'transient-scope', manager, slice, limits? }` or
   `{ kind: 'process-root' }`. A host that cannot make the asked boundary refuses with a named
   reason; nothing is ever started as a plain child instead. `slice: 'caller'` keeps the caller's
   own slice — and with it the limits that slice carries — and is refused when the caller has
   none under that manager.
4. **A scope is made by the host's manager with the arguments passed as written.** The line is
   `systemd-run [--user] --scope --quiet --collect --expand-environment=no --unit=<launcher>-<id>.scope
   --description=<label> --slice=<slice> [--property=…] -- <command>`. A systemd older than 254
   is refused as `systemd-too-old`: without the option the command's arguments are rewritten, and
   a boundary that corrupts what it launches is not a degraded mode worth having. The unit name is
   computed one way only; it is never parsed back into an owner, because two owners can spell one
   name.
5. **Two forms, one mechanism.** `workCommand` returns argv and environment for any spawner — the
   multiplexer, a remote shell, another supervisor. `launchWork` runs that same argv through the
   native-command owner and resolves once the root is observed inside the boundary, with the
   root's pid and process instance.
6. **The variable names, the boundary proves.** `STITCHKIT_WORK_ORIGIN` holds a versioned JSON
   value: the work's reference and its boundary. Every descendant inherits it, including one that
   later leaves the boundary, so it is a claim. `checkWorkMembership` asks the boundary: for a
   scope, the unit must be a component of the process's control-group path; for a process root,
   the process is the root, is in the group the root leads, or has a parent chain that reaches
   the root while the root is still the recorded process instance. The answer is `member`,
   `outside`, `gone` or `unavailable` with a reason, and `unavailable` is never folded into
   another answer. An unreadable variable is refused, not read as "no origin".
7. **A process root is a package-owned entry that becomes the command.** Where there is no
   transient scope — macOS, or a Linux host named so on purpose — the package's entry measures its
   own process instance, writes it into the variable, and replaces itself with the command by
   `execve`: same pid, same start, no process left in between. Its stated limit: a descendant that
   left the group and lost its parent is `outside`. A scope would still hold it.
8. **The bundled bootstrap serves every package-owned invocation.** A single-file application
   starts itself again for the owner-loss guard and for a process root. One narrow entry carries
   both: `stitchkit/process/owner-loss` becomes `stitchkit/process/bootstrap`, and
   `bootstrapNativeCommandOwnerLoss()` becomes `bootstrapPackageProcess()`. The old name is
   removed, not aliased.
9. **This is not a supervisor.** There is no restart, no registry and no daemon. The scope belongs
   to the host's manager; `stop()` asks that manager to stop the unit, which also ends processes
   that left the root's group.

## Consequences

- A monitor names the owner of a process on Linux by reading its control group, taking the scope
  unit, and matching `workUnitName` of each launcher's records; it never has to trust the variable.
- A nested launcher declares `parent: await inheritedWork()`, which is the inherited reference
  only when this process is proven to be inside that boundary.
- Work in a scope of its own is no longer in its launcher's service control group: stopping or
  restarting that service leaves the scopes running. A launcher that wants the old behaviour stops
  its scopes itself.
- The check by unit name proves "in a live scope with this name", not "in that very incarnation".
  It rests on the launcher keeping ids unique among its live work and on the manager refusing a
  loaded name. A control-group id can be added to the launch result later without a break.
- A user-manager scope and a system-manager scope with the same unit name are not told apart by
  the membership check; a launcher uses one manager for one launcher name.
- Hosts with a systemd older than 254 cannot use a transient scope and are told so by name.
- Applications that bundled `stitchkit/process/owner-loss` change one import and one call.

## Not verified here

An unprivileged caller's `--user` scope, including one requested from inside a system service;
the behaviour of a systemd older than 254 itself (the refusal is by reported version); and the
process root on macOS — `execve` keeping the pid and the start time, the `ps` reading of parent
and group, and the bundled bootstrap there — which only a Darwin runner can prove.
