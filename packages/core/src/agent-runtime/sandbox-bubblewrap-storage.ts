import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  SandboxError,
  type SandboxPrewarmInput,
  type SandboxState,
  SandboxStateSchema,
} from './sandbox-contract';
import { sandboxPath } from './sandbox-session';

const Key = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function sandboxStorage(root: string, name: string) {
  const base = join(root, digest(name));
  async function prewarm(input: SandboxPrewarmInput) {
    const files = Object.entries(input.files ?? {})
      .map(([path, bytes]) => [path, Uint8Array.from(bytes)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const key = digest(
      JSON.stringify([
        name,
        input.template,
        files.map(([path, bytes]) => [
          sandboxPath(path),
          createHash('sha256').update(bytes).digest('hex'),
        ]),
      ]),
    );
    const directory = join(base, 'templates', key);
    await mkdir(join(base, 'templates'), { recursive: true, mode: 0o700 });
    try {
      await readFile(join(directory, 'ready'));
      return { reused: true, templateKey: key };
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = join(base, 'templates', randomUUID());
    await mkdir(join(temporary, 'data'), { recursive: true, mode: 0o700 });
    try {
      for (const [path, bytes] of files) {
        const resolved = sandboxPath(path);
        if (resolved === '/workspace')
          throw new SandboxError('SANDBOX_PATH', 'Template file cannot be the workspace root');
        const target = join(temporary, 'data', resolved.slice(11));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
      await writeFile(
        join(temporary, 'ready'),
        JSON.stringify({ backend: name, templateKey: key }),
      );
      try {
        await rename(temporary, directory);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            ['EEXIST', 'ENOTEMPTY'].includes(String(error.code))
          )
        )
          throw error;
      }
      return { reused: false, templateKey: key };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async function acquire(id: string) {
    const directory = join(base, 'sessions', Key.parse(id));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const lease = await open(join(directory, 'lease'), 'wx', 0o600);
      try {
        await lease.writeFile(String(process.pid));
      } catch (error) {
        await rm(join(directory, 'lease'), { force: true });
        throw error;
      } finally {
        await lease.close();
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw new SandboxError('SANDBOX_BUSY', 'Sandbox session already has an owner');
      throw error;
    }
    return { directory, release: () => rm(join(directory, 'lease'), { force: true }) };
  }
  async function create(template: string, saved?: SandboxState) {
    Key.parse(template);
    if (saved && (saved.backend !== name || saved.templateKey !== template))
      throw new SandboxError(
        'SANDBOX_STATE_MISMATCH',
        'Reconnect state does not match backend and template',
      );
    const templateDirectory = join(base, 'templates', template);
    const record = z
      .object({ backend: z.string(), templateKey: z.string() })
      .parse(JSON.parse(await readFile(join(templateDirectory, 'ready'), 'utf8')));
    if (record.backend !== name || record.templateKey !== template)
      throw new SandboxError('SANDBOX_STATE_MISMATCH', 'Template belongs to another backend');
    const state = saved
      ? SandboxStateSchema.parse(saved)
      : { backend: name, sessionId: digest(randomUUID()), templateKey: template };
    if (state.backend !== name || state.templateKey !== template)
      throw new SandboxError(
        'SANDBOX_STATE_MISMATCH',
        'Reconnect state does not match backend and template',
      );
    const lease = await acquire(state.sessionId);
    try {
      const statePath = join(lease.directory, 'state.json');
      if (saved) {
        const existing = SandboxStateSchema.parse(
          JSON.parse(await readFile(statePath, 'utf8')),
        );
        if (JSON.stringify(existing) !== JSON.stringify(state))
          throw new SandboxError(
            'SANDBOX_STATE_MISMATCH',
            'Reconnect identity does not match saved session',
          );
      } else {
        await cp(join(templateDirectory, 'data'), join(lease.directory, 'workspace'), {
          recursive: true,
        });
        await writeFile(statePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      }
      return { ...lease, workspace: join(lease.directory, 'workspace'), state };
    } catch (error) {
      try {
        if (!saved) await rm(lease.directory, { recursive: true, force: true });
      } finally {
        await lease.release();
      }
      throw error;
    }
  }
  return { prewarm, create, acquire };
}
function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
