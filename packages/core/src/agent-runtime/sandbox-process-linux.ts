import { lstatSync } from 'node:fs';
import { posix } from 'node:path';
import {
  type ProcessSandboxCommandSpec,
  type ProcessSandboxSpec,
  ProcessSandboxSpecSchema,
  resolveProcessSandboxEnv,
} from './sandbox-process-spec';

/** Default path to Bubblewrap on Linux. */
export const DEFAULT_BWRAP_EXECUTABLE = '/usr/bin/bwrap';

function pathCoveredByAny(target: string, roots: readonly string[]): boolean {
  const normalizedTarget = posix.normalize(target);
  for (const root of roots) {
    const normalizedRoot = posix.normalize(root);
    if (normalizedTarget === normalizedRoot) return true;
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    if (normalizedTarget.startsWith(prefix)) return true;
  }
  return false;
}

/** Build the Bubblewrap CLI arguments for a long-lived streaming process. */
export function buildLinuxBubblewrapArgs(
  rawSpec: ProcessSandboxSpec,
  command: ProcessSandboxCommandSpec,
): string[] {
  const spec = ProcessSandboxSpecSchema.parse(rawSpec);
  const network = spec.network ?? 'deny';
  const args: string[] = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
  ];

  if (network === 'allow') {
    args.push('--share-net');
  }

  if (spec.systemReadOnlyPaths !== undefined) {
    for (const systemPath of spec.systemReadOnlyPaths) {
      args.push('--ro-bind', systemPath, systemPath);
    }
  } else {
    args.push(
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/sbin',
      '/sbin',
      '--ro-bind-try',
      '/etc/ssl',
      '/etc/ssl',
      '--ro-bind-try',
      '/etc/ca-certificates',
      '/etc/ca-certificates',
      '--ro-bind-try',
      '/etc/ld.so.cache',
      '/etc/ld.so.cache',
    );
    if (network === 'allow') {
      args.push(
        '--ro-bind-try',
        '/etc/resolv.conf',
        '/etc/resolv.conf',
        '--ro-bind-try',
        '/etc/hosts',
        '/etc/hosts',
        '--ro-bind-try',
        '/etc/nsswitch.conf',
        '/etc/nsswitch.conf',
      );
    }
  }

  // Mount virtual filesystems and a private /tmp BEFORE real-path workspace/allowlist mounts
  // so workspaces under /tmp remain accessible while sibling directories under /tmp stay hidden.
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');

  const systemRoots = spec.systemReadOnlyPaths ?? [
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/etc',
  ];
  const mountedRoots = [
    ...systemRoots,
    spec.workspace,
    ...(spec.writableDirs ?? []),
    ...(spec.readOnlyPaths ?? []),
    ...(spec.privateTmpDir !== undefined ? [spec.privateTmpDir] : []),
  ];

  // Mount an isolated tmpfs homeDir BEFORE workspace and allowlist binds so an ancestor
  // homeDir hides host siblings without masking child workspace or allowlisted mounts.
  const homeDir = spec.homeDir;
  const virtualAndSystemRoots = [...systemRoots, '/proc', '/dev', '/tmp'];
  if (
    homeDir !== undefined &&
    !pathCoveredByAny(homeDir, mountedRoots) &&
    !virtualAndSystemRoots.some((root) => pathCoveredByAny(root, [homeDir]))
  ) {
    args.push('--tmpfs', homeDir);
  }

  args.push(
    spec.profile === 'workspace-strict' ? '--bind' : '--ro-bind',
    spec.workspace,
    spec.workspace,
  );

  for (const roPath of spec.readOnlyPaths ?? []) {
    args.push('--ro-bind', roPath, roPath);
  }

  for (const rwDir of spec.writableDirs ?? []) {
    args.push('--bind', rwDir, rwDir);
  }

  if (spec.privateTmpDir !== undefined) {
    args.push('--bind', spec.privateTmpDir, spec.privateTmpDir);
  }

  const allMountedRoots = homeDir !== undefined ? [...mountedRoots, homeDir] : mountedRoots;

  for (const sock of spec.unixSockets ?? []) {
    args.push('--bind', sock.hostPath, sock.mountPath ?? sock.hostPath);
  }

  // Apply explicit denyPaths last so files/sockets/directories inside mounted trees are masked.
  // A path outside all mounted roots is already absent from the sandbox filesystem.
  for (const denied of spec.denyPaths ?? []) {
    if (!pathCoveredByAny(denied, allMountedRoots)) continue;
    try {
      const stat = lstatSync(denied);
      if (stat.isDirectory()) {
        args.push('--tmpfs', denied);
      } else {
        args.push('--ro-bind', '/dev/null', denied);
      }
    } catch {
      // Absent on host: nothing exists inside the sandbox to expose.
    }
  }

  const resolvedEnv = resolveProcessSandboxEnv(spec, command.env);
  args.push('--clearenv');
  for (const [key, value] of Object.entries(resolvedEnv)) {
    args.push('--setenv', key, value);
  }

  const sandboxCwd = resolveLinuxSandboxCwd(spec.workspace, command.cwd, allMountedRoots);
  args.push('--chdir', sandboxCwd, '--', command.executable, ...command.args);
  return args;
}

function resolveLinuxSandboxCwd(
  workspace: string,
  requestedCwd: string,
  mountedRoots: readonly string[],
): string {
  return posix.normalize(requestedCwd) === '/tmp' ||
    pathCoveredByAny(requestedCwd, mountedRoots)
    ? requestedCwd
    : workspace;
}

/** Build the Linux Bubblewrap wrapped command for a long-lived process. */
export function buildLinuxBubblewrapCommand(
  spec: ProcessSandboxSpec,
  command: ProcessSandboxCommandSpec,
): ProcessSandboxCommandSpec {
  const parsed = ProcessSandboxSpecSchema.parse(spec);
  const executable = parsed.bwrapExecutable ?? DEFAULT_BWRAP_EXECUTABLE;
  const args = buildLinuxBubblewrapArgs(parsed, command);
  const mountedRoots = [
    ...(parsed.systemReadOnlyPaths ?? ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']),
    parsed.workspace,
    ...(parsed.writableDirs ?? []),
    ...(parsed.readOnlyPaths ?? []),
    ...(parsed.privateTmpDir !== undefined ? [parsed.privateTmpDir] : []),
    ...(parsed.homeDir !== undefined ? [parsed.homeDir] : []),
  ];
  const sandboxCwd = resolveLinuxSandboxCwd(parsed.workspace, command.cwd, mountedRoots);
  // Child environment is passed exclusively via `--clearenv` + `--setenv` inside `bwrap`.
  return {
    executable,
    args,
    cwd: sandboxCwd,
    env: {},
  };
}
