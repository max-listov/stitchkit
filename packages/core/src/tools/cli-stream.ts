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
import { safeJsonParse } from '../internal/safe-json';
import { isRecord } from '../internal/typed';
import { readCliCheckpoint, writeCliCheckpoint } from './cli-checkpoint';
import { defineCliCommand } from './cli-command';
import type { CliInvocationResult, CliInvoker } from './cli-invoke';

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

/** Run every line of `input`, answering each one. */
export async function runCliStream(
  invoker: CliInvoker,
  input: string,
  onAnswer: (answer: CliStreamAnswer) => void,
): Promise<void> {
  for (const line of input.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseLine(line);
    if (!parsed.ok) {
      onAnswer(parsed.answer);
      continue;
    }
    const outcome = await invoker.invoke(parsed.value.command, parsed.value.args);
    onAnswer({ id: parsed.value.id, ...outcome });
  }
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
    // A required string field, so the framework's own stdin routing fills it:
    // a piped stream lands here exactly as `--lines "$(cat)"` would, and no
    // second way of reading stdin is invented for this command.
    input: z.object({ lines: z.string() }),
    handler: async (context) => {
      const invoker =
        typeof config.invoker === 'function' ? await config.invoker() : config.invoker;
      const input = context.input.lines;
      await runCliStream(invoker, input, (answer) => {
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
      lines: z.string(),
      checkpoint: z.string().optional(),
    }),
    handler: async (context) => {
      const invoker =
        typeof config.invoker === 'function' ? await config.invoker() : config.invoker;
      const path =
        context.input.checkpoint ?? config.checkpointPath ?? '.stitchkit-batch.json';
      const checkpoint = readCliCheckpoint(path);
      const input = context.input.lines;

      for (const line of input.split('\n')) {
        if (line.trim() === '') continue;
        const parsed = parseLine(line);
        if (!parsed.ok) {
          context.stdout(`${JSON.stringify(parsed.answer)}\n`);
          continue;
        }
        const { id, command, args } = parsed.value;
        const digest = checkpoint.digestOf({ command, args });
        const recorded = checkpoint.entries[id];
        if (recorded) {
          if (recorded.digest !== digest) {
            const conflict: CliStreamAnswer = {
              id,
              ok: false,
              exitCode: 2,
              error: {
                code: 'CONFLICT',
                message:
                  'this id was already run with different content — change the id or start a new checkpoint',
              },
            };
            context.stdout(`${JSON.stringify(conflict)}\n`);
            continue;
          }
          const replay = isRecord(recorded.answer) ? recorded.answer : {};
          context.stdout(`${JSON.stringify({ ...replay, id, replayed: true })}\n`);
          continue;
        }
        const outcome = await invoker.invoke(command, args);
        const answer: CliStreamAnswer = { id, ...outcome };
        checkpoint.record(id, digest, outcome);
        // Written per line, not at the end: a checkpoint that only survives a
        // clean finish protects against exactly the case that does not happen.
        writeCliCheckpoint(path, checkpoint);
        context.stdout(`${JSON.stringify(answer)}\n`);
      }
    },
  });
}
