import { badRequest } from '../contract';

function requestAbortReason(req: Request): unknown {
  return req.signal.reason ?? new DOMException('The connection was closed', 'AbortError');
}

function throwIfRequestAborted(req: Request): void {
  if (req.signal.aborted) throw requestAbortReason(req);
}

export function assertJsonBodyLimit(maxBytes: number | undefined, owner: string): void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error(`${owner} must be a positive safe integer, received ${maxBytes}`);
  }
}

/** Read UTF-8 request text, optionally stopping before a configured byte cap is exceeded. */
export async function readRequestText(req: Request, maxBytes?: number): Promise<string> {
  // A runtime may abort the Fetch Request before a delayed body read starts.
  // `req.text()` is then allowed to remain pending on a transport stream that
  // has already disappeared, so fail from the request's canonical reason first.
  throwIfRequestAborted(req);
  if (maxBytes === undefined) return req.text();
  assertJsonBodyLimit(maxBytes, 'maxJsonBodyBytes');

  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbortedRead = (_reason: unknown): void => undefined;
  const abortedRead = new Promise<never>((_resolve, reject) => {
    rejectAbortedRead = reject;
  });
  const onAbort = (): void => {
    const reason = requestAbortReason(req);
    rejectAbortedRead(reason);
    // Reject the dispatcher path first; transport-owned stream cancellation is
    // best-effort cleanup and must not keep a client-closed request pending.
    void reader.cancel(reason).catch(() => undefined);
  };
  req.signal.addEventListener('abort', onAbort, { once: true });
  // Unreachable while the guard at the top of this function is the first
  // statement and nothing above awaits — an abort cannot land in between. Kept
  // so the subscription is correct by construction rather than by that
  // non-local invariant: an `await` introduced above would otherwise reopen the
  // pending-read hang this race exists to prevent.
  if (req.signal.aborted) onAbort();
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortedRead]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        badRequest(`JSON body exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    req.signal.removeEventListener('abort', onAbort);
    // A cancelled reader keeps its lock until the runtime settles cancellation;
    // releasing it while a read is pending would itself throw a secondary error.
    if (!req.signal.aborted) reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
