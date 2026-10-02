import type { z } from 'zod';
import { startNativeCommand } from '../process/command-owner';
import { NativeCommandError } from '../process/contract';
import { stopCommandGroup } from '../process/group';
import type { NativeCommandLaunchedProcess } from '../process/launch';
import { type AgentCodingToolConfig, ShellOutputSchema } from './coding-tool-contract';
import { utf8AlignedEnd, utf8AlignedStart } from './coding-tool-utf8';
import type { AgentProcessSandbox } from './sandbox';

/** Head and tail of `data` within `budget` bytes, each cut on a character boundary. */
function preview(data: Buffer, budget: number) {
  if (data.byteLength <= budget) {
    return { data, headBytes: data.byteLength, tailBytes: 0, omittedBytes: 0 };
  }
  // The head is cut by bytes and then pulled back to a character boundary;
  // the tail is pulled forward. Without this a byte budget regularly split a
  // multi-byte character and the preview carried a replacement glyph, so the
  // model read a character that is not on the disk.
  const headEnd = utf8AlignedEnd(data, 0, Math.ceil(budget / 2));
  const tailStart = Math.max(
    headEnd,
    utf8AlignedStart(data, data.byteLength - Math.floor(budget / 2), data.byteLength),
  );
  const tailBytes = data.byteLength - tailStart;
  return {
    data: Buffer.concat([data.subarray(0, headEnd), data.subarray(tailStart)]),
    headBytes: headEnd,
    tailBytes,
    omittedBytes: data.byteLength - headEnd - tailBytes,
  };
}

// Without an artifact the preview is the retained prefix itself, and its own
// end is where the retention budget cut it. Align that cut too, or a byte
// budget landing inside a multi-byte character still produces a replacement
// glyph. The bytes pulled back are counted as omitted rather than lost.
function retainedPreview(data: Buffer) {
  const end = utf8AlignedEnd(data, 0, data.byteLength);
  return {
    data: data.subarray(0, end),
    headBytes: end,
    tailBytes: 0,
    omittedBytes: data.byteLength - end,
  };
}

export async function runCodingShell(input: {
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
  authorization?: Parameters<NonNullable<AgentCodingToolConfig['authorize']>>[0];
  spawn?: () => ReturnType<NonNullable<AgentProcessSandbox['spawn']>>;
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
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const artifactStdout: Buffer[] = [];
  const artifactStderr: Buffer[] = [];
  let retained = 0;
  let artifactBytes = 0;
  let outcome: z.infer<typeof ShellOutputSchema>['outcome'] = 'exited';
  let child: NativeCommandLaunchedProcess | undefined;
  let exitCode: number | null = null;
  let signal: string | null = null;
  const outputLimit = new Error('Coding command output retention budget exceeded');
  const launch = input.spawn;
  const retain = (target: Buffer[], artifactTarget: Buffer[], chunk: Uint8Array) => {
    const remaining = Math.max(0, input.maxOutputBytes - retained);
    if (remaining > 0) {
      const kept = Buffer.from(chunk.subarray(0, remaining));
      target.push(kept);
      retained += kept.byteLength;
    }
    if (input.artifacts) {
      const artifactRemaining = Math.max(0, artifactPayloadLimit - artifactBytes);
      if (artifactRemaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, artifactRemaining));
        artifactTarget.push(kept);
        artifactBytes += kept.byteLength;
      }
      if (chunk.byteLength > artifactRemaining) throw outputLimit;
    } else if (chunk.byteLength > remaining) throw outputLimit;
  };
  const command = startNativeCommand(
    {
      executable: input.executable,
      args: [...input.args],
      cwd: input.cwd,
      env: { ...input.environment },
      envPolicy: 'declared-only',
      signal: input.signal ?? new AbortController().signal,
      killGraceMs: 0,
      onOutput: (bytes, channel) =>
        retain(
          channel === 'stdout' ? stdout : stderr,
          channel === 'stdout' ? artifactStdout : artifactStderr,
          bytes,
        ),
      onLeaderSettled: async (event) => {
        if (event.kind !== 'exit') return;
        exitCode = event.exitCode;
        signal = event.signal;
        // Coding commands own descendants after leader exit; generic commands choose their own policy.
        if (process.platform !== 'win32')
          await stopCommandGroup(child?.pid, 0, input.terminationGraceMs, true);
      },
    },
    (started) => {
      child = started;
    },
    {
      group: process.platform !== 'win32',
      force: true,
      timeoutMs: input.timeoutMs,
      cleanupTimeoutMs: input.terminationGraceMs,
      closeTimeoutMs: input.terminationGraceMs,
      ...(launch
        ? {
            launch: () => {
              child = launch();
              return child;
            },
          }
        : {}),
      maxBufferedBytes: Math.max(
        64 * 1024,
        input.maxOutputBytes,
        input.artifacts ? artifactPayloadLimit : 0,
      ),
    },
  );
  try {
    const result = await command.result;
    exitCode = result.exitCode;
    signal = result.signal;
  } catch (error) {
    if (error === outputLimit) outcome = 'output-limit';
    else if (input.signal?.aborted && error === input.signal.reason) outcome = 'cancelled';
    else if (
      error instanceof NativeCommandError &&
      error.code === 'COMMAND_LIMIT' &&
      (error.reason === 'deadline' || error.reason === 'output-budget')
    )
      outcome = error.reason === 'deadline' ? 'timeout' : 'output-limit';
    else if (
      error instanceof DOMException &&
      error.name === 'AbortError' &&
      error.message === 'Command stopped'
    )
      outcome = 'cancelled';
    else throw error;
    exitCode = child?.exitCode ?? exitCode;
    signal = child?.signalCode ?? signal;
  }
  const hasArtifact = input.artifacts && artifactBytes > input.maxOutputBytes;
  const completeStdout = Buffer.concat(artifactStdout);
  const completeStderr = Buffer.concat(artifactStderr);
  const artifactData = hasArtifact
    ? Buffer.concat([stdoutHeader, completeStdout, stderrHeader, completeStderr])
    : undefined;
  const stdoutBudget =
    completeStderr.byteLength === 0
      ? input.maxOutputBytes
      : Math.ceil(input.maxOutputBytes / 2);
  const stderrBudget =
    completeStdout.byteLength === 0
      ? input.maxOutputBytes
      : Math.floor(input.maxOutputBytes / 2);
  const stdoutPreview = hasArtifact
    ? preview(completeStdout, stdoutBudget)
    : retainedPreview(Buffer.concat(stdout));
  const stderrPreview = hasArtifact
    ? preview(completeStderr, stderrBudget)
    : retainedPreview(Buffer.concat(stderr));
  const persisted = hasArtifact
    ? await input.artifacts?.write({
        mediaType: 'text/plain; charset=utf-8',
        data: artifactData ?? new Uint8Array(),
        ...(input.authorization && { authorization: input.authorization }),
      })
    : undefined;
  return ShellOutputSchema.parse({
    executable: input.executableName,
    exitCode,
    signal,
    stdout: stdoutPreview.data.toString('utf8'),
    stderr: stderrPreview.data.toString('utf8'),
    outcome,
    ...(persisted && {
      artifact: {
        reference: persisted.reference,
        bytes: artifactData?.byteLength ?? 0,
        truncated: outcome === 'output-limit',
        headBytes: stdoutPreview.headBytes + stderrPreview.headBytes,
        tailBytes: stdoutPreview.tailBytes + stderrPreview.tailBytes,
        omittedBytes: stdoutPreview.omittedBytes + stderrPreview.omittedBytes,
      },
    }),
  });
}
