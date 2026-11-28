import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { SandboxError } from './sandbox-contract';
import {
  type ProcessSandboxCommandSpec,
  type ProcessSandboxSpec,
  ProcessSandboxSpecSchema,
  resolveProcessSandboxEnv,
} from './sandbox-process-spec';

const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function escapeSeatbeltString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function uniqueVariants(path: string): string[] {
  const set = new Set<string>([path]);
  try {
    const resolved = realpathSync(path);
    if (resolved.length > 0) set.add(resolved);
  } catch {
    // Path may not exist yet on host (for example when generating a profile cross-platform).
  }
  return [...set];
}

function allowWriteSubpaths(
  lines: string[],
  paths: readonly string[],
  emitted: Set<string>,
): void {
  for (const raw of paths) {
    for (const variant of uniqueVariants(raw)) {
      if (emitted.has(variant)) continue;
      emitted.add(variant);
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltString(variant)}"))`);
    }
  }
}

/**
 * Compile a macOS Seatbelt (SBPL) profile from a {@link ProcessSandboxSpec}.
 * Pure and safe to call on any OS for deterministic policy verification.
 *
 * Read/write security model on macOS Seatbelt:
 * - **Default-deny writes**: `(deny file-write*)` blocks all filesystem writes except
 *   `/dev/{null,zero,tty,dtracehelper}`, `privateTmpDir`, `workspace` (under `workspace-strict`),
 *   `homeDir`, `writableDirs`, and explicitly declared `unixSockets`.
 * - **Default-allow reads with explicit `denyPaths`**: `(allow default)` permits host reads
 *   required by dyld/system frameworks and provider binaries while `denyPaths` denies both
 *   `file-read*` and `file-write*`. Unlike Linux `bwrap` (mount-namespace allowlist), callers on
 *   macOS MUST list sensitive host paths (control sockets, sibling workspaces, host secrets) in
 *   `denyPaths`.
 * - **No mount remapping**: macOS Seatbelt cannot bind-mount a Unix socket to a different path;
 *   supplying `unixSockets[].mountPath !== hostPath` fails closed with `SANDBOX_UNAVAILABLE`.
 */
export function buildSeatbeltProfile(spec: ProcessSandboxSpec): string {
  const parsed = ProcessSandboxSpecSchema.parse(spec);
  for (const sock of parsed.unixSockets ?? []) {
    if (
      sock.mountPath !== undefined &&
      posix.normalize(sock.mountPath) !== posix.normalize(sock.hostPath)
    ) {
      throw new SandboxError(
        'SANDBOX_UNAVAILABLE',
        `macOS Seatbelt cannot remap Unix socket mountPath "${sock.mountPath}" from hostPath "${sock.hostPath}"; omit mountPath or set it equal to hostPath`,
      );
    }
  }

  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
  ];

  const writableEmitted = new Set<string>();
  if (parsed.privateTmpDir !== undefined) {
    allowWriteSubpaths(lines, [parsed.privateTmpDir], writableEmitted);
  }
  if (parsed.profile === 'workspace-strict') {
    allowWriteSubpaths(lines, [parsed.workspace], writableEmitted);
  }
  if (parsed.homeDir !== undefined) {
    allowWriteSubpaths(lines, [parsed.homeDir], writableEmitted);
  }
  if (parsed.writableDirs !== undefined && parsed.writableDirs.length > 0) {
    allowWriteSubpaths(lines, parsed.writableDirs, writableEmitted);
  }

  // Enforce workspace read-only AFTER broad write allowlists so workspace writes stay denied.
  if (parsed.profile === 'workspace-readonly') {
    for (const variant of uniqueVariants(parsed.workspace)) {
      lines.push(`(deny file-write* (subpath "${escapeSeatbeltString(variant)}"))`);
    }
  }

  // Allow explicitly configured Unix sockets AFTER workspace-readonly deny so a socket inside
  // a read-only workspace remains connectable, while explicit denyPaths below still win.
  if (parsed.unixSockets !== undefined && parsed.unixSockets.length > 0) {
    for (const sock of parsed.unixSockets) {
      for (const variant of uniqueVariants(sock.hostPath)) {
        lines.push(
          `(allow file-read* file-write* (literal "${escapeSeatbeltString(variant)}"))`,
        );
      }
    }
  }

  // Explicit denyPaths always win over earlier allows (including control sockets and sibling dirs).
  if (parsed.denyPaths !== undefined && parsed.denyPaths.length > 0) {
    for (const denied of parsed.denyPaths) {
      for (const variant of uniqueVariants(denied)) {
        const escaped = escapeSeatbeltString(variant);
        lines.push(
          `(deny file-read* file-write* (literal "${escaped}") (subpath "${escaped}"))`,
        );
      }
    }
  }

  if ((parsed.network ?? 'deny') === 'deny') {
    lines.push('(deny network*)');
    if (parsed.unixSockets !== undefined && parsed.unixSockets.length > 0) {
      for (const sock of parsed.unixSockets) {
        for (const variant of uniqueVariants(sock.hostPath)) {
          lines.push(
            `(allow network-outbound (remote unix-socket (path-literal "${escapeSeatbeltString(variant)}")))`,
          );
        }
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Build the macOS `sandbox-exec` wrapped command for a long-lived process. */
export function buildMacOsSeatbeltCommand(
  spec: ProcessSandboxSpec,
  command: ProcessSandboxCommandSpec,
): ProcessSandboxCommandSpec {
  const executable = spec.sandboxExecExecutable ?? DEFAULT_SANDBOX_EXEC;
  const profile = buildSeatbeltProfile(spec);
  const env = resolveProcessSandboxEnv(spec, command.env);
  return {
    executable,
    args: ['-p', profile, '--', command.executable, ...command.args],
    cwd: command.cwd,
    env,
  };
}
