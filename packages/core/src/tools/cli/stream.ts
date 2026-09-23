/**
 * One operation per line, and a batch that can be resumed.
 *
 * Every agent-facing CLI grows the same two commands, and the mechanics contain
 * nothing about any product: read a line, run the operation, answer with the
 * same id, do not let one bad line stop the stream — and for a batch, do not
 * run again what already ran.
 *
 * They are factories rather than framework-owned command names. Reserving
 * `jsonl` and `batch` would take two names out of a namespace that belongs to
 * the consumer: an application that already has a `batch` command would either
 * fail at startup or find its own command silently shadowed. So the consumer
 * mounts these under whatever it calls them, exactly like its own commands.
 */
import { z } from 'zod';
import { safeJsonParse } from '../../internal/safe-json';
import { isRecord } from '../../internal/typed';
import { readCliCheckpoint, writeCliCheckpoint } from './checkpoint';
import { defineCliCommand } from './command';
import type { CliInvocationResult, CliInvoker } from './invoke';

/** One line's answer: the id it came with, plus what running it produced. */
export interface CliStreamAnswer extends CliInvocationResult {
  /** Correlation id, echoed from the line. */
  id: string;
  /** Present when this answer was replayed from a checkpoint rather than run. */
  replayed?: true;
}

/** One parsed line of the stream. */
const LineSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

export interface CliStreamCommandConfig {
  /** Command name — the consumer's namespace, not the framework's. */
  name?: string;
  description?: string;
  /** The compiled surface to run against. */
  invoker: CliInvoker | (() => Promise<CliInvoker>);
  /**
   * Where the lines come from. Default: `process.stdin`, **as they arrive**.
   *
   * This is the difference between a pipe and a conversation. The framework's
   * ordinary stdin routing accumulates the whole stream and hands the command a
   * string, which is right for `--prompt "$(cat file)"` and fatally wrong here:
   * an agent that writes one line and waits for its answer would wait for its
   * own EOF, which never comes. So the stream owns its input and answers each
   * line as it is read.
   */
  readLines?: () => AsyncIterable<string>;
}

/**
 * Lines from a byte stream, delivered as they arrive.
 *
 * Split on `\n` with a trailing `\r` dropped, so a producer on Windows is not a
 * silent parse failure on every line. A final line with no newline is delivered
 * at end of stream rather than discarded.
 */
export async function* readStdinLines(
  source: AsyncIterable<Uint8Array | string> = process.stdin,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of source) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      newline = pending.indexOf('\n');
    }
  }
  if (pending !== '') yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
}

function parseLine(
  line: string,
): { ok: true; value: z.output<typeof LineSchema> } | { ok: false; answer: CliStreamAnswer } {
  let parsed: unknown;
  try {
    parsed = safeJsonParse(line);
  } catch {
    return { ok: false, answer: malformed('the line is not JSON') };
  }
  const result = LineSchema.safeParse(parsed);
  if (!result.success) {
    const id = isRecord(parsed) && typeof parsed.id === 'string' ? parsed.id : undefined;
    return {
      ok: false,
      answer: {
        ...malformed('the line needs `id` and `command`'),
        ...(id !== undefined && { id }),
      },
    };
  }
  return { ok: true, value: result.data };
}

function malformed(message: string): CliStreamAnswer {
  return {
    // A line too broken to carry an id still gets an answer, because a stream
    // that goes silent on one line is a stream whose consumer cannot tell which
    // request it lost.
    id: '',
    ok: false,
    exitCode: 2,
    error: { code: 'BAD_REQUEST', message },
  };
}

/**
 * Run each line as it arrives, answering before reading the next.
 *
 * Sequential on purpose: the answers carry ids, so a consumer could correlate
 * out-of-order ones — but a stream that runs ahead of its answers removes the
 * one form of backpressure an agent has, which is not answering yet.
 */
export async function runCliStream(
  invoker: CliInvoker,
  lines: AsyncIterable<string>,
  onAnswer: (answer: CliStreamAnswer) => void,
  hooks: CliStreamHooks = {},
): Promise<void> {
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const parsed = parseLine(line);
    if (!parsed.ok) {
      onAnswer(parsed.answer);
      continue;
    }
    const { id, command, args } = parsed.value;
    const answered = hooks.before?.(id, { command, args });
    if (answered) {
      onAnswer(answered);
      continue;
    }
    const outcome = await invoker.invoke(command, args);
    hooks.after?.(id, { command, args }, outcome);
    onAnswer({ id, ...outcome });
  }
}

/** What a caller decides per line, without owning the loop that reads them. */
export interface CliStreamHooks {
  /** Answer this line without running it — a replay, or a refusal. */
  before?: (
    id: string,
    line: { command: string; args: Record<string, unknown> },
  ) => CliStreamAnswer | undefined;
  /** Observe what running it produced, before the answer is written. */
  after?: (
    id: string,
    line: { command: string; args: Record<string, unknown> },
    outcome: CliInvocationResult,
  ) => void;
}

/**
 * A stream command the consumer mounts under its own name.
 *
 * Answers go to stdout one JSON object per line; nothing else does, so a script
 * can read stdout as data while diagnostics stay on stderr.
 */
export function defineCliStreamCommand(config: CliStreamCommandConfig) {
  return defineCliCommand({
    name: config.name ?? 'stream',
    description:
      config.description ?? 'Run one operation per JSON line of stdin, answering each',
    input: z.object({}),
    handler: async (context) => {
      const invoker =
        typeof config.invoker === 'function' ? await config.invoker() : config.invoker;
      await runCliStream(invoker, (config.readLines ?? readStdinLines)(), (answer) => {
        context.stdout(`${JSON.stringify(answer)}\n`);
      });
    },
  });
}

export interface CliBatchCommandConfig extends CliStreamCommandConfig {
  /** Where the checkpoint lives. Relative paths resolve against the process cwd. */
  checkpointPath?: string;
}

/**
 * A resumable batch.
 *
 * The checkpoint records, per line id, the digest of the line that produced the
 * recorded answer. A re-run replays what already ran; a line whose CONTENT
 * changed under the same id is refused rather than quietly re-run or quietly
 * replayed, because both of those answer a question nobody asked.
 */
export function defineCliBatchCommand(config: CliBatchCommandConfig) {
  return defineCliCommand({
    name: config.name ?? 'batch',
    description:
      config.description ??
      'Run one operation per JSON line of stdin, resuming from a checkpoint',
    input: z.object({
      checkpoint: z.string().optional(),
    }),
    handler: async (context) => {
      const invoker =
        typeof config.invoker === 'function' ? await config.invoker() : config.invoker;
      const path =
        context.input.checkpoint ?? config.checkpointPath ?? '.stitchkit-batch.json';
      const checkpoint = readCliCheckpoint(path);

      await runCliStream(
        invoker,
        (config.readLines ?? readStdinLines)(),
        (answer) => {
          context.stdout(`${JSON.stringify(answer)}\n`);
        },
        {
          // The batch differs from the stream in one decision per line — has
          // this already run — so it supplies that decision rather than
          // repeating the loop that reads, parses and answers.
          before: (id, line) => {
            const digest = checkpoint.digestOf(line);
            const recorded = checkpoint.entries[id];
            if (!recorded) return undefined;
            if (recorded.digest !== digest) {
              return {
                id,
                ok: false,
                exitCode: 2,
                error: {
                  code: 'CONFLICT',
                  message:
                    'this id was already run with different content — change the id or start a new checkpoint',
                },
              };
            }
            const replay = isRecord(recorded.answer) ? recorded.answer : {};
            return { ...replay, id, replayed: true } as CliStreamAnswer;
          },
          after: (id, line, outcome) => {
            // Only a SUCCESS is recorded. The reason to record at all is that
            // re-running an operation that already happened repeats its effect;
            // a failure had no effect, and remembering it would make the batch
            // unfinishable — one rate limit and that line replays its own
            // failure forever, with the only escape being to delete the
            // checkpoint and lose the lines that did succeed.
            if (!outcome.ok) return;
            checkpoint.record(id, checkpoint.digestOf(line), outcome);
            // Written per line, not at the end: a checkpoint that only survives
            // a clean finish protects against exactly the case that does not
            // happen.
            writeCliCheckpoint(path, checkpoint);
          },
        },
      );
    },
  });
}
