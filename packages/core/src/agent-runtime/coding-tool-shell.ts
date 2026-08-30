import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import type { z } from 'zod';
import { defineRuntimeTool } from '../tools/runtime-tool';
import {
  type AgentCodingToolConfig,
  type AgentCodingToolDefinition,
  type AgentCodingToolLimits,
  createShellInputSchema,
  ShellOutputSchema,
} from './coding-tool-contract';
import { authorizeCodingTool, existingCodingPath } from './coding-tool-paths';

async function runShell(input: {
  executableName: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs: number;
  terminationGraceMs: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  artifacts?: AgentCodingToolConfig['artifacts'];
}) {
  const stdoutHeader = Buffer.from('--- stdout ---\n');
  const stderrHeader = Buffer.from('\n--- stderr ---\n');
  const artifactPayloadLimit =
    input.maxArtifactBytes - stdoutHeader.byteLength - stderrHeader.byteLength;
  if (input.artifacts && artifactPayloadLimit < 0)
    throw new Error('maxArtifactBytes is smaller than the shell artifact envelope');
  if (input.signal?.aborted) {
    return ShellOutputSchema.parse({
      executable: input.executableName,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      outcome: 'cancelled',
    });
  }
  return await new Promise<z.infer<typeof ShellOutputSchema>>((resolve, reject) => {
    const ownsProcessGroup = process.platform !== 'win32';
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: ownsProcessGroup,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const artifactStdout: Buffer[] = [];
    const artifactStderr: Buffer[] = [];
    let retained = 0;
    let artifactBytes = 0;
    let outcome: z.infer<typeof ShellOutputSchema>['outcome'] = 'exited';
    let settled = false;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => terminate('cancelled');
    const cleanup = () => {
      clearTimeout(timer);
      if (settlementTimer) clearTimeout(settlementTimer);
      input.signal?.removeEventListener('abort', cancel);
    };
    const persistAndResolve = async (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const hasArtifact = input.artifacts && artifactBytes > input.maxOutputBytes;
        const artifactData = hasArtifact
          ? Buffer.concat([stdoutHeader, ...artifactStdout, stderrHeader, ...artifactStderr])
          : undefined;
        const persisted = hasArtifact
          ? await input.artifacts?.write({
              mediaType: 'text/plain; charset=utf-8',
              data: artifactData ?? new Uint8Array(),
            })
          : undefined;
        resolve(
          ShellOutputSchema.parse({
            executable: input.executableName,
            exitCode,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            outcome,
            ...(persisted && {
              artifact: {
                reference: persisted.reference,
                bytes: artifactData?.byteLength ?? 0,
                truncated: outcome === 'output-limit',
              },
            }),
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
    const killOwnedProcessGroup = (): boolean => {
      if (!ownsProcessGroup || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    };
    const boundStreamSettlement = () => {
      if (settlementTimer) return;
      settlementTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        void persistAndResolve(child.exitCode, child.signalCode);
      }, input.terminationGraceMs);
    };
    const terminate = (reason: typeof outcome) => {
      if (settled || outcome !== 'exited') return;
      outcome = reason;
      if (!killOwnedProcessGroup()) child.kill('SIGKILL');
      boundStreamSettlement();
    };
    const timer = setTimeout(() => terminate('timeout'), input.timeoutMs);
    timer.unref();
    const retain = (target: Buffer[], artifactTarget: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, input.maxOutputBytes - retained);
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        target.push(kept);
        retained += kept.byteLength;
      }
      if (input.artifacts) {
        const artifactRemaining = Math.max(0, artifactPayloadLimit - artifactBytes);
        if (artifactRemaining > 0) {
          const kept = chunk.subarray(0, artifactRemaining);
          artifactTarget.push(kept);
          artifactBytes += kept.byteLength;
        }
        if (chunk.byteLength > artifactRemaining) terminate('output-limit');
      } else if (chunk.byteLength > remaining) terminate('output-limit');
    };
    child.stdout.on('data', (chunk: Buffer) => retain(stdout, artifactStdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => retain(stderr, artifactStderr, chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('exit', (exitCode, signal) => {
      // A finite command owns every descendant that remains in its POSIX process group.
      // Killing the group after a normal parent exit prevents a background child from
      // retaining the pipes and turning an exited command into an unbounded operation.
      if (outcome === 'exited') killOwnedProcessGroup();
      boundStreamSettlement();
      if (child.stdout.destroyed && child.stderr.destroyed) {
        void persistAndResolve(exitCode, signal);
      }
    });
    child.on('close', (exitCode, signal) => void persistAndResolve(exitCode, signal));
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();
  });
}

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
      const cwd = await existingCodingPath(root, input.cwd, limits.maxPathBytes);
      if (!(await stat(cwd.absolute)).isDirectory()) {
        throw new Error('Coding tool cwd is not a directory');
      }
      await authorizeCodingTool(config, {
        operation: 'shell',
        executable: input.executable,
        args: input.args,
        cwd: cwd.relative,
      });
      return runShell({
        executableName: input.executable,
        executable,
        args: input.args,
        cwd: cwd.absolute,
        environment: config.environment ?? {},
        ...(signal && { signal }),
        timeoutMs: limits.shellTimeoutMs,
        terminationGraceMs: limits.shellTerminationGraceMs,
        maxOutputBytes: limits.maxShellOutputBytes,
        maxArtifactBytes: limits.maxArtifactBytes,
        ...(config.artifacts && { artifacts: config.artifacts }),
      });
    },
  });
}
