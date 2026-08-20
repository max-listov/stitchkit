/**
 * `mountWait` — a generic native MCP tool that blocks until an async job
 * reaches a terminal state. The poll loop is the shared `pollUntil`; the app
 * injects only the domain bits (what to poll, when it's done). Owns the MCP
 * wiring so the consumer never imports the MCP server package directly. → ADR 0019.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isRecord } from '../internal/typed';
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
    async (rawArgs) => {
      const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
      try {
        const { state, timedOut } = await runWaitOperation({
          input: args,
          poll: (input) => config.poll(input),
          done: config.done,
          backoff: config.backoff,
          timeoutSec: config.timeoutFromArgs?.(args) ?? config.defaultTimeout,
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
