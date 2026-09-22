/**
 * `mountWait` — a generic native MCP tool that blocks until an async job
 * reaches a terminal state. The poll loop is the shared `pollUntil`; the app
 * injects only the domain bits (what to poll, when it's done). Owns the MCP
 * wiring so the consumer never imports the MCP server package directly. → ADR 0019.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isRecord } from '../internal/typed';
import { createMcpProgressReporter } from './mcp-progress';
import { assertToolName } from './names';
import { textResult } from './native-result';
import { runWaitOperation } from './wait-core';

export interface WaitToolConfig {
  /** Tool name. Default `'wait'`. */
  name?: string;
  description: string;
  /** Tool input shape (e.g. `{ id: z.string() }`). */
  inputSchema: z.ZodRawShape;
  /** Fetch the current state for the call's args — one poll tick. */
  poll: (args: Record<string, unknown>) => Promise<unknown>;
  /** Terminal when this returns `true`. */
  done: (state: unknown) => boolean;
  /** Read a per-call timeout (seconds) from the args. */
  timeoutFromArgs?: (args: Record<string, unknown>) => number | undefined;
  /** Backoff schedule in seconds; the last entry repeats. */
  backoff?: number[];
  /** Default timeout in seconds. */
  defaultTimeout?: number;
  /** Render the final state. Default: pretty JSON, `isError` on timeout. */
  render?: (state: unknown, timedOut: boolean) => { text: string; isError: boolean };
}

/**
 * Register a native "wait" tool — polls `config.poll(args)` with backoff until
 * `config.done` or the timeout, then returns the final state.
 */
export function mountWait(server: McpServer, config: WaitToolConfig): void {
  const name = config.name ?? 'wait';
  // A native tool lands in the SAME `tools/list` as the contract tools, so one
  // undeliverable name here takes them all down too. → ADR 0035.
  assertToolName(name, '<native>', 'wait');
  server.registerTool(
    name,
    { description: config.description, inputSchema: z.object(config.inputSchema) },
    async (rawArgs, mcpContext) => {
      const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
      // The whole reason this tool exists is that the work outlives the call,
      // and in a text host that reads as silence. The poll loop already knows
      // it is alive and what it last saw; reporting that is relaying a fact,
      // not guessing a stage. A host that asked for no progress gets a no-op.
      const report = createMcpProgressReporter(mcpContext);
      let last: unknown;
      try {
        const { state, timedOut } = await runWaitOperation({
          input: args,
          poll: async (input) => {
            last = await config.poll(input);
            return last;
          },
          done: config.done,
          backoff: config.backoff,
          timeoutSec: config.timeoutFromArgs?.(args) ?? config.defaultTimeout,
          onTick: (attempt, elapsedSec) => {
            // What the loop actually knows. `phase` when the polled value
            // declares one — the async-operation snapshot does — and that
            // snapshot's own numeric `progress` when it has one, because a
            // measured number beats the ordinal of a poll. `progress` there is
            // an application-declared shape, so it is used only when it really
            // is a number; otherwise the tick stands for itself and answers the
            // question the silence raised: is anything happening at all.
            const snapshot = isRecord(last) ? last : undefined;
            const phase = typeof snapshot?.phase === 'string' ? snapshot.phase : undefined;
            const measured =
              typeof snapshot?.progress === 'number' && Number.isFinite(snapshot.progress)
                ? snapshot.progress
                : undefined;
            void report({
              progress: measured ?? attempt,
              message: phase
                ? `${phase} — poll ${attempt}, ${Math.round(elapsedSec)}s elapsed`
                : `poll ${attempt}, ${Math.round(elapsedSec)}s elapsed`,
            });
          },
        });
        const rendered = config.render
          ? config.render(state, timedOut)
          : { text: JSON.stringify(state, null, 2), isError: timedOut };
        return textResult(rendered.text, rendered.isError);
      } catch (err) {
        // A rejected poll / render reaches here — frame it with the tool's own
        // prefix instead of leaning on the MCP SDK to catch the raw rejection.
        return textResult(
          `Wait failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );
}
