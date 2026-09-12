import { realpath, stat } from 'node:fs/promises';
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
  existingCodingPath,
} from './coding-tool-paths';
import { codingRefusal } from './coding-tool-refusals';
import { missingSandboxRestrictions, probeAgentProcessSandbox } from './sandbox';

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
      const root = await realpath(config.root);
      // The same SHAPE guard every file tool applies. The path policy stays
      // deliberately out of `run_command` — an executable needs process
      // isolation, not path filtering — but that is a decision about
      // authorization, not a reason for `cwd` to accept spellings the file
      // tools refuse. Without this, `a/../b` and `a\\b` were accepted here and
      // refused everywhere else.
      const cwd = await existingCodingPath(
        root,
        input.cwd === '.'
          ? '.'
          : boundedCodingRelativePath(root, input.cwd, limits.maxPathBytes),
        limits.maxPathBytes,
      );
      if (!(await stat(cwd.absolute)).isDirectory()) {
        throw new Error('Coding tool cwd is not a directory');
      }
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
        const grade = await probeAgentProcessSandbox(config.sandbox.adapter);
        if (grade.grade === 'unavailable') {
          codingRefusal(
            'SANDBOX_UNAVAILABLE',
            'The configured process sandbox is unavailable',
            {
              details: { reason: grade.reason },
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
          const refreshed = await probeAgentProcessSandbox(config.sandbox.adapter, {
            refresh: true,
          });
          codingRefusal(
            'SANDBOX_UNAVAILABLE',
            'The process sandbox failed while preparing a command',
            {
              details: {
                grade: refreshed.grade,
                reason: error instanceof Error ? error.message : 'unknown sandbox error',
              },
            },
          );
        }
      }
      return runCodingShell({
        ...(config.sandbox?.adapter.spawn && {
          spawn: () => {
            const adapter = config.sandbox?.adapter;
            if (!adapter?.spawn) throw new Error('Sandbox launcher is unavailable');
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
        cwd: cwd.absolute,
        environment,
        ...(signal && { signal }),
        timeoutMs: limits.shellTimeoutMs,
        terminationGraceMs: limits.shellTerminationGraceMs,
        maxOutputBytes: limits.maxShellOutputBytes,
        maxArtifactBytes: limits.maxArtifactBytes,
        ...(config.artifacts && { artifacts: config.artifacts }),
        authorization: shellAuthorization,
      });
    },
  });
}
