import { posix } from 'node:path';
import {
  SandboxCommandSchema,
  type SandboxDriver,
  SandboxError,
  SandboxNetworkPolicySchema,
  type SandboxSession,
} from './sandbox-contract';

export function sandboxPath(path: string): string {
  const relative = path.startsWith('/workspace/') ? path.slice(11) : path;
  if (path === '/workspace' || path === '.') return '/workspace';
  if (
    !relative ||
    relative.startsWith('/') ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((part) => part === '..' || part === '' || part === '.')
  ) {
    throw new SandboxError('SANDBOX_PATH', 'Expected a canonical workspace-relative path');
  }
  return posix.join('/workspace', relative);
}
/** One public composition for every backend; text never gets its own I/O engine. */
export function createSandboxSession(
  id: string,
  driver: SandboxDriver,
  brokerSocket?: string,
): SandboxSession {
  const spawn: SandboxSession['spawn'] = (command, options) => {
    const parsed = SandboxCommandSchema.parse(command);
    return driver.spawn({ ...parsed, cwd: sandboxPath(parsed.cwd ?? '.') }, options);
  };
  return {
    id,
    ...(brokerSocket && { brokerSocket }),
    resolvePath: sandboxPath,
    readBinaryFile: (path) => driver.read(sandboxPath(path)),
    readTextFile: async (path) =>
      new TextDecoder('utf-8', { fatal: true }).decode(await driver.read(sandboxPath(path))),
    writeBinaryFile: (path, bytes) => driver.write(sandboxPath(path), bytes),
    writeTextFile: (path, text) =>
      driver.write(sandboxPath(path), new TextEncoder().encode(text)),
    removePath: (path) => {
      const resolved = sandboxPath(path);
      if (resolved === '/workspace')
        throw new SandboxError('SANDBOX_PATH', 'Cannot remove the workspace root');
      return driver.remove(resolved);
    },
    spawn,
    async run(command, options) {
      const result = await (await spawn(command, options)).result;
      return {
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    },
    setNetworkPolicy: (policy) =>
      driver.setNetworkPolicy(SandboxNetworkPolicySchema.parse(policy)),
  };
}
