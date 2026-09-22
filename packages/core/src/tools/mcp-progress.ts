/**
 * Progress for a call that is still running.
 *
 * A tool that takes ten minutes tells a text host nothing today: the call is
 * made, and the next thing the host sees is the answer. The protocol has the
 * channel for this — the host sends a `progressToken` in the request's `_meta`
 * and the server relates `notifications/progress` to that request — and the
 * framework simply never read the token.
 *
 * Both places that can report live here, so there is one implementation of
 * "what a progress update is": the contract-tool path (`mcp-round.ts`, which
 * hands `reportProgress` to the handler) and the native wait tool
 * (`mount-wait.ts`, which reports its own poll ticks).
 */
import type { ServerContext } from '@modelcontextprotocol/server';
import type { McpProgressUpdate, McpReportProgress } from '../contract';

/**
 * The host's progress token, or `undefined` when it asked for none.
 *
 * It rides in the request's own `_meta`, beside the trace keys, and survives
 * the SDK's envelope lift because it is not an envelope key. `_meta` itself can
 * be absent entirely — the SDK drops it when the lift empties it — so "no
 * `_meta`" and "`_meta` without a token" have to mean the same thing here.
 */
export function mcpProgressToken(context: ServerContext): string | number | undefined {
  const token: unknown = context.mcpReq._meta?.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
}

/**
 * Build the reporter for one call.
 *
 * Without a token it is a no-op, so nothing upstream has to ask whether the
 * host is listening. With one, every update is a `notifications/progress`
 * related to this request.
 *
 * `progress` is required by the protocol and is often the one thing a handler
 * does not know — it has a stage to name and no scale to name it on. An
 * omitted one becomes the ordinal of this update, which is a fact about what
 * happened; a synthesised percentage would be a claim nobody measured. `total`
 * stays absent in that case, so a host renders an unbounded counter rather
 * than a bar stuck at 3%.
 *
 * Nothing here can fail the call. A transport that refuses the notification
 * leaves the host without progress, which is exactly the state of every host
 * that never asked for it — and a message about work must not be able to kill
 * the work it describes.
 */
export function createMcpProgressReporter(context: ServerContext): McpReportProgress {
  const token = mcpProgressToken(context);
  if (token === undefined) return async () => undefined;
  let sent = 0;
  return async (update: McpProgressUpdate): Promise<void> => {
    sent += 1;
    try {
      await context.mcpReq.notify({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: update.progress ?? sent,
          ...(update.total !== undefined && { total: update.total }),
          ...(update.message !== undefined && { message: update.message }),
        },
      });
    } catch {
      // Deliberately swallowed — see the docblock.
    }
  };
}
