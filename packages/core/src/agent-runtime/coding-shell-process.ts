import { spawn } from 'node:child_process';
import type { z } from 'zod';
import { type AgentCodingToolConfig, ShellOutputSchema } from './coding-tool-contract';
import { utf8AlignedEnd, utf8AlignedStart } from './coding-tool-utf8';
import type { AgentProcessSandbox } from './sandbox';

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
  const preview = (data: Buffer, budget: number) => {
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
  };
  // Without an artifact the preview is the retained prefix itself, and its own
  // end is where the retention budget cut it. Align that cut too, or a byte
  // budget landing inside a multi-byte character still produces a replacement
  // glyph. The bytes pulled back are counted as omitted rather than lost.
  const retainedPreview = (data: Buffer) => {
    const end = utf8AlignedEnd(data, 0, data.byteLength);
    return {
      data: data.subarray(0, end),
      headBytes: end,
      tailBytes: 0,
      omittedBytes: data.byteLength - end,
    };
  };
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
    const child: ReturnType<NonNullable<AgentProcessSandbox['spawn']>> = input.spawn
      ? input.spawn()
      : spawn(input.executable, input.args, {
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
    const persistAndResolve = async (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
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
        resolve(
          ShellOutputSchema.parse({
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
    child.stdout.on('data', (chunk: Uint8Array) =>
      retain(stdout, artifactStdout, Buffer.from(chunk)),
    );
    child.stderr.on('data', (chunk: Uint8Array) =>
      retain(stderr, artifactStderr, Buffer.from(chunk)),
    );
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
