/** How a response body ended: read to the end, broken by the network, or cancelled by its reader. */
export type ObservedEnd =
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'cancel'; readonly reason: unknown };

export interface BodyObserver {
  contentType: string;
  /** Longest event in characters (one SSE line, or a whole JSON body) parsed; longer ones are skipped. */
  maxEventLength: number;
  onFirstChunk(): void;
  onEvent(value: unknown): void;
  onEnd(end: ObservedEnd): void;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Server-sent events: each complete `data:` line is one JSON event; a partial line is held, bounded. */
function sseParser(observer: BodyObserver) {
  let line = '';
  let skipping = false;
  const take = (complete: string) => {
    if (!complete.startsWith('data:')) return;
    const data = complete.slice(5).trim();
    if (data.length === 0 || data === '[DONE]') return;
    const value = parsed(data);
    if (value !== undefined) observer.onEvent(value);
  };
  return {
    push(text: string) {
      let rest = text;
      for (let at = rest.indexOf('\n'); at !== -1; at = rest.indexOf('\n')) {
        const piece = rest.slice(0, at).replace(/\r$/, '');
        rest = rest.slice(at + 1);
        if (!skipping) take(line + piece);
        line = '';
        skipping = false;
      }
      if (skipping) return;
      line += rest;
      if (line.length > observer.maxEventLength) {
        line = '';
        skipping = true;
      }
    },
    end() {
      if (!skipping && line.length > 0) take(line.replace(/\r$/, ''));
    },
  };
}

/** A JSON body: kept whole up to the bound and parsed at the end. */
function jsonParser(observer: BodyObserver) {
  let body = '';
  let over = false;
  return {
    push(text: string) {
      if (over) return;
      body += text;
      if (body.length > observer.maxEventLength) {
        body = '';
        over = true;
      }
    },
    end() {
      if (over || body.length === 0) return;
      const value = parsed(body);
      if (value !== undefined) observer.onEvent(value);
    },
  };
}

/**
 * The body the caller reads, unchanged byte for byte, with the observer told what
 * passed through and how it ended. `onEnd` fires exactly once — at the end, on a
 * network error, or when the caller cancels — so the attempt is always closed.
 */
export function observeBody(
  body: ReadableStream<Uint8Array>,
  observer: BodyObserver,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = observer.contentType.includes('text/event-stream')
    ? sseParser(observer)
    : observer.contentType.includes('json')
      ? jsonParser(observer)
      : undefined;
  let first = true;
  let ended = false;
  const end = (outcome: ObservedEnd) => {
    if (ended) return;
    ended = true;
    if (outcome.kind === 'done') {
      parser?.push(decoder.decode());
      parser?.end();
    }
    observer.onEnd(outcome);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read().catch((error: unknown) => {
        end({ kind: 'error', error });
        controller.error(error);
        return undefined;
      });
      if (chunk === undefined) return;
      if (chunk.done) {
        end({ kind: 'done' });
        controller.close();
        return;
      }
      if (first) {
        first = false;
        observer.onFirstChunk();
      }
      parser?.push(decoder.decode(chunk.value, { stream: true }));
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      end({ kind: 'cancel', reason });
      await reader.cancel(reason);
    },
  });
}
