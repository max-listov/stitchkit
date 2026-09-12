import type { SandboxCommand, SandboxNetworkPolicy } from './sandbox-contract';

/** Only immutable runtime directories are exposed; host homes, /run and /etc are absent. */
export function bubblewrapArgs(input: {
  workspace: string;
  socket: string;
  command: SandboxCommand;
  network: SandboxNetworkPolicy;
}) {
  const args = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/sbin',
    '/sbin',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/run',
    '--bind',
    input.workspace,
    '/workspace',
    '--ro-bind',
    input.socket,
    '/run/stitchkit-network.sock',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/workspace',
  ];
  if (input.network === 'allow-all')
    args.push('--share-net', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf');
  for (const [key, value] of Object.entries(input.command.environment ?? {}))
    args.push('--setenv', key, value);
  args.push(
    '--chdir',
    input.command.cwd ?? '/workspace',
    '--',
    input.command.executable,
    ...(input.command.args ?? []),
  );
  return args;
}
