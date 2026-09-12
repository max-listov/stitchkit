import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { createSandboxBroker } from './sandbox-broker';
import { bubblewrapArgs } from './sandbox-bubblewrap-args';
import { sandboxStorage } from './sandbox-bubblewrap-storage';
import { createSandboxCodingAdapter } from './sandbox-coding-adapter';
import {
  type SandboxBackend,
  type SandboxDriver,
  SandboxError,
  SandboxNetworkPolicySchema,
} from './sandbox-contract';
import { spawnSandboxProcess } from './sandbox-process';
import { sandboxProcessOwner } from './sandbox-process-owner';
import { createSandboxSession } from './sandbox-session';

export interface BubblewrapSandboxConfig {
  /** Private, application-owned directory, never mounted into the guest. */
  stateDirectory: string;
  name?: string;
  executable?: string;
  /** Maximum live commands across session calls and the coding profile. Defaults to 8. */
  maxConcurrentCommands?: number;
  /** Internal diagnostic sink; errors are never sent back to the guest. */
  onBrokerError: (cause: unknown) => void;
}
/** Linux reference backend. Bubblewrap and a conventional /usr,/lib,/lib64 runtime are required. */
export async function createBubblewrapSandboxBackend(
  config: BubblewrapSandboxConfig,
): Promise<SandboxBackend> {
  if (process.platform !== 'linux')
    throw new SandboxError('SANDBOX_UNAVAILABLE', 'Bubblewrap requires Linux');
  const executable = config.executable ?? '/usr/bin/bwrap';
  const name = z
    .string()
    .min(1)
    .parse(config.name ?? 'bubblewrap');
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(config.stateDirectory);
  const storage = sandboxStorage(root, name);
  const maximum = z
    .number()
    .int()
    .positive()
    .max(1024)
    .parse(config.maxConcurrentCommands ?? 8);
  return {
    name,
    prewarm: storage.prewarm,
    async create(input) {
      let policy = SandboxNetworkPolicySchema.parse(input.network);
      const stored = await storage.create(input.template, input.state);
      async function abandon() {
        try {
          if (!input.state) await rm(stored.directory, { recursive: true, force: true });
        } finally {
          await stored.release();
        }
      }
      const temporary = await mkdtemp(join(tmpdir(), 'stitchkit-sandbox-')).catch(
        async (error) => {
          await abandon();
          throw error;
        },
      );
      const socket = join(temporary, 'network.sock');
      let active = true;
      let deleted = false;
      let stopPending: Promise<void> | undefined;
      const broker = await createSandboxBroker(
        socket,
        () => policy,
        config.onBrokerError,
      ).catch(async (error) => {
        await abandon();
        await rm(temporary, { recursive: true, force: true });
        throw error;
      });
      const assertActive = () => {
        if (!active) throw new SandboxError('SANDBOX_STOPPED', 'Sandbox session is stopped');
      };
      const processes = sandboxProcessOwner(assertActive, maximum);
      const coding = createSandboxCodingAdapter({
        workspace: stored.workspace,
        socket,
        executable,
        getPolicy: () => policy,
        processes,
        assertActive,
      });
      const driver: SandboxDriver = {
        async spawn(command, options) {
          processes.admit();
          const process = spawnSandboxProcess(
            executable,
            bubblewrapArgs({ workspace: stored.workspace, socket, command, network: policy }),
            {
              timeoutMs: command.timeoutMs ?? 30_000,
              maxOutputBytes: command.maxOutputBytes ?? 1_048_576,
            },
            options,
            processes.track,
          );
          return process;
        },
        async read(path) {
          return (await execute('/usr/bin/cat', ['--', path])).stdout;
        },
        async write(path, bytes) {
          if (bytes.byteLength > 1_048_576)
            throw new SandboxError('SANDBOX_LIMIT', 'Sandbox file write limit exceeded');
          await execute('/usr/bin/mkdir', ['-p', '--', posix.dirname(path)]);
          await execute('/usr/bin/tee', ['--', path], bytes);
        },
        async remove(path) {
          await execute('/usr/bin/rm', ['-rf', '--', path]);
        },
        async setNetworkPolicy(next) {
          assertActive();
          if (processes.size)
            throw new SandboxError(
              'SANDBOX_BUSY',
              'Stop live commands before changing network policy',
            );
          broker.abortRequests();
          policy = SandboxNetworkPolicySchema.parse(next);
          await coding.refresh();
        },
      };
      async function execute(binary: string, args: string[], stdin?: Uint8Array) {
        const result = await (await driver.spawn({ executable: binary, args }, { stdin }))
          .result;
        if (result.exitCode !== 0)
          throw new SandboxError('SANDBOX_UNAVAILABLE', 'Sandbox file operation failed');
        return result;
      }
      function stop() {
        if (stopPending) return stopPending;
        active = false;
        stopPending = (async () => {
          await processes.stop();
          try {
            await broker.close();
          } finally {
            try {
              await rm(temporary, { recursive: true, force: true });
            } finally {
              await stored.release();
            }
          }
        })();
        return stopPending;
      }
      try {
        await execute('/usr/bin/true', []);
      } catch (error) {
        await stop();
        if (!input.state) await rm(stored.directory, { recursive: true, force: true });
        throw new SandboxError(
          'SANDBOX_UNAVAILABLE',
          'Bubblewrap could not establish isolation',
          { cause: error },
        );
      }
      return {
        coding: { root: stored.workspace, adapter: coding.adapter, assertActive },
        session: createSandboxSession(
          stored.state.sessionId,
          driver,
          '/run/stitchkit-network.sock',
        ),
        captureState() {
          if (deleted) throw new SandboxError('SANDBOX_STOPPED', 'Sandbox session is deleted');
          return { ...stored.state };
        },
        stop,
        shutdown: stop,
        async delete() {
          if (deleted) return;
          await stop();
          // An old stopped handle must never delete a session reattached by a new owner.
          const lease = await storage.acquire(stored.state.sessionId);
          try {
            await rm(lease.directory, { recursive: true, force: true });
            deleted = true;
          } catch (error) {
            await lease.release();
            throw error;
          }
        },
      };
    },
  };
}
