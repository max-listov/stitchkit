import { fstatSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { openContainedDirectory } from '../internal/contained-files';
import { defineRuntimeTool } from '../tools/runtime-tool';
import { runCodingShell } from './coding-shell-process';
import {
  type AgentCodingToolConfig,
  type AgentCodingToolDefinition,
  type AgentCodingToolLimits,
  createShellInputSchema,
  ShellOutputSchema,
} from './coding-tool-contract';
import {
  authorizeCodingTool,
  boundedCodingRelativePath,
  withCodingRoot,
} from './coding-tool-paths';
import { codingRefusal, refuseUnopenableCodingDirectory } from './coding-tool-refusals';
import { missingSandboxRestrictions, probeAgentProcessSandboxOutcome } from './sandbox';

export function createShellCodingTool(
  config: AgentCodingToolConfig,
  limits: AgentCodingToolLimits,
): AgentCodingToolDefinition {
  const executables = config.executables ?? {};
  const executableNames = Object.keys(executables).sort();
  return defineRuntimeTool({
    name: 'run_command',
    description:
      'Run a finite host-declared executable with bounded arguments, time and output.',
    identity: { serviceName: 'coding', action: 'shell', method: 'POST' },
    input: createShellInputSchema(executableNames),
    output: ShellOutputSchema,
    transports: ['AGENT'],
    handler: async ({ input, signal }) => {
      if (input.args.length > limits.maxShellArguments) {
        throw new Error('Coding tool shell arguments exceed maxShellArguments');
      }
      const argumentBytes = input.args.reduce(
        (total, argument) => total + Buffer.byteLength(argument),
        0,
      );
      if (argumentBytes > limits.maxShellArgumentBytes) {
        throw new Error('Coding tool shell arguments exceed maxShellArgumentBytes');
      }
      const executable = executables[input.executable];
      if (!executable) throw new Error('Coding tool executable is not declared');
      return withCommandDirectory(config.root, input.cwd, limits.maxPathBytes, async (cwd) => {
        const assertSandboxCwd = cwd.assertCurrent;
        const shellAuthorization = {
          operation: 'shell',
          executable: input.executable,
          args: input.args,
          cwd: cwd.relative,
        } as const;
        await authorizeCodingTool(config, shellAuthorization);
        let executablePath = executable;
        let executableArgs = input.args;
        let environment = config.environment ?? {};
        if (config.sandbox) {
          assertSandboxCwd();
          // An adapter's error carries paths and raw tool output: it rides on the refusal as its
          // `cause`, which the mount's `onToolError` hook receives, and the agent sees a fixed
          // reason.
          const probed = await probeAgentProcessSandboxOutcome(config.sandbox.adapter);
          const grade = probed.grade;
          if (grade.grade === 'unavailable') {
            codingRefusal(
              'SANDBOX_UNAVAILABLE',
              'The configured process sandbox is unavailable',
              {
                details: { reason: grade.reason },
                ...(probed.cause !== undefined && { cause: probed.cause }),
              },
            );
          }
          const missing = missingSandboxRestrictions(grade, config.sandbox.required);
          if (missing.length > 0) {
            codingRefusal(
              'SANDBOX_INSUFFICIENT',
              'The process sandbox lacks required restrictions',
              {
                details: { missing, grade: grade.grade },
              },
            );
          }
          try {
            const prepared = await config.sandbox.adapter.prepare({
              required: config.sandbox.required,
              executable,
              args: input.args,
              cwd: cwd.absolute,
              environment,
            });
            executablePath = prepared.executable;
            executableArgs = [...prepared.args];
            environment = prepared.environment ?? environment;
          } catch (error) {
            const refreshed = await probeAgentProcessSandboxOutcome(config.sandbox.adapter, {
              refresh: true,
            });
            codingRefusal(
              'SANDBOX_UNAVAILABLE',
              'The process sandbox failed while preparing a command',
              {
                details: { grade: refreshed.grade.grade, reason: 'sandbox prepare failed' },
                cause:
                  refreshed.cause === undefined
                    ? error
                    : new AggregateError(
                        [error, refreshed.cause],
                        'Sandbox prepare failed and probing it again failed',
                      ),
              },
            );
          }
        }
        // A pathname directory (sandboxes, platforms without contained descriptors) is checked
        // once more after every host decision; a pinned descriptor needs no name.
        if (config.sandbox || cwd.descriptor === undefined) assertSandboxCwd();
        const ordinary = !config.sandbox?.adapter.spawn && cwd.descriptor !== undefined;
        // Linux enters the pinned directory through its magic link, which the kernel resolves to
        // the descriptor's own directory, not by name; macOS has none, so a guard enters it with
        // fchdir before the command starts.
        const linkedCwd =
          ordinary && process.platform === 'linux'
            ? `/proc/${process.pid}/fd/${cwd.descriptor}`
            : undefined;
        return await runCodingShell({
          ...(ordinary &&
            linkedCwd === undefined &&
            cwd.descriptor !== undefined && { cwdDescriptor: cwd.descriptor }),
          ...(config.sandbox?.adapter.spawn && {
            spawn: () => {
              const adapter = config.sandbox?.adapter;
              if (!adapter?.spawn) throw new Error('Sandbox launcher is unavailable');
              assertSandboxCwd();
              return adapter.spawn({
                executable: executablePath,
                args: executableArgs,
                cwd: cwd.absolute,
                environment,
              });
            },
          }),
          executableName: input.executable,
          executable: executablePath,
          args: executableArgs,
          cwd: linkedCwd ?? cwd.absolute,
          environment,
          ...(signal && { signal }),
          timeoutMs: limits.shellTimeoutMs,
          terminationGraceMs: limits.shellTerminationGraceMs,
          maxOutputBytes: limits.maxShellOutputBytes,
          maxArtifactBytes: limits.maxArtifactBytes,
          ...(config.artifacts && { artifacts: config.artifacts }),
          authorization: shellAuthorization,
        });
      });
    },
  });
}

interface CommandDirectory {
  relative: string;
  absolute: string;
  /** The pinned directory the ordinary launcher enters, where the platform has one. */
  descriptor?: number;
  /** Refuses when the directory's pathname no longer names the authorized directory. */
  assertCurrent(): void;
}

/**
 * The command's working directory under the root. On Linux and macOS it is a pinned descriptor
 * opened without following symlinks; elsewhere, where contained descriptors are unavailable,
 * it is the requested directory when its realpath is that same name under the root (a symlink
 * segment refuses), and its identity is checked again immediately before launch.
 */
async function withCommandDirectory<T>(
  configuredRoot: string,
  requested: string,
  maxPathBytes: number,
  work: (cwd: CommandDirectory) => Promise<T>,
): Promise<T> {
  // The same SHAPE guard every file tool applies. The path policy stays deliberately out of
  // `run_command` — an executable needs process isolation, not path filtering — but that is a
  // decision about authorization, not a reason for `cwd` to accept spellings the file tools
  // refuse.
  const shaped = (root: string) =>
    requested === '.' ? '.' : boundedCodingRelativePath(root, requested, maxPathBytes);
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    const root = await realpath(configuredRoot);
    const relative = shaped(root);
    const absolute = path.resolve(root, relative);
    const resolved = await realpath(absolute).catch((error: unknown) =>
      refuseUnopenableCodingDirectory(error, relative),
    );
    const identity = await stat(resolved);
    // A symlink anywhere in the spelling is refused, as the descriptor walk refuses it — also
    // one leading outside the root, which therefore never resolves to a different place.
    if (!identity.isDirectory() || resolved !== absolute) {
      refuseUnopenableCodingDirectory(
        Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }),
        relative,
      );
    }
    const found = { relative, absolute };
    return work({
      ...found,
      assertCurrent: () => {
        const current = statSync(found.absolute);
        if (identity.dev !== current.dev || identity.ino !== current.ino)
          codingRefusal('CONFLICT', 'Command directory changed during authorization');
      },
    });
  }
  return withCodingRoot(configuredRoot, async (root, rootPath) => {
    const relative = shaped(rootPath);
    const directory = await openContainedDirectory(root, relative).catch((error: unknown) =>
      refuseUnopenableCodingDirectory(error, relative),
    );
    try {
      const absolute = path.resolve(rootPath, relative);
      return await work({
        relative,
        absolute,
        descriptor: directory.fd,
        // Sandboxes own their launcher and require a host pathname: a stale name is refused at
        // the handoff, while the ordinary launcher uses the capability itself.
        assertCurrent: () => {
          const expected = fstatSync(directory.fd);
          const current = statSync(absolute);
          if (expected.dev !== current.dev || expected.ino !== current.ino)
            codingRefusal('CONFLICT', 'Command directory changed during authorization');
        },
      });
    } finally {
      await directory.close();
    }
  });
}
