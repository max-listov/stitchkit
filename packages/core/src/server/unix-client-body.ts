import type { IncomingMessage } from 'node:http';
import { UnixClientTransportError } from './unix-client-error';

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const body = request.body;
  if (!body) return undefined;

  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new UnixClientTransportError(
      'UNIX_REQUEST_TOO_LARGE',
      `Unix request body exceeds the ${maxBytes} byte limit`,
      'not-dispatched',
    );
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (request.signal.aborted) throw request.signal.reason;
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        throw new UnixClientTransportError(
          'UNIX_REQUEST_TOO_LARGE',
          `Unix request body exceeds the ${maxBytes} byte limit`,
          'not-dispatched',
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function incomingResponseBody(
  response: IncomingMessage,
  maxBytes: number | undefined,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  let finished = false;
  let received = 0;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    onDone();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        response.pause();
        response.on('data', (chunk: Buffer) => {
          if (finished) return;
          if (maxBytes !== undefined) received += chunk.byteLength;
          if (maxBytes !== undefined && received > maxBytes) {
            controller.error(
              new UnixClientTransportError(
                'UNIX_RESPONSE_TOO_LARGE',
                `Unix response body exceeds the ${maxBytes} byte limit`,
                'response-received',
              ),
            );
            response.destroy();
            finish();
            return;
          }
          controller.enqueue(new Uint8Array(chunk));
          response.pause();
        });
        response.once('end', () => {
          if (finished) return;
          controller.close();
          finish();
        });
        response.once('aborted', () => {
          if (finished) return;
          controller.error(
            new UnixClientTransportError(
              'UNIX_RESPONSE_ABORTED',
              'Unix response was aborted before completion',
              'response-received',
            ),
          );
          finish();
        });
        response.once('error', (error) => {
          if (finished) return;
          controller.error(
            new UnixClientTransportError(
              'UNIX_RESPONSE_ABORTED',
              'Unix response failed before completion',
              'response-received',
              { cause: error },
            ),
          );
          finish();
        });
      },
      pull() {
        response.resume();
      },
      cancel() {
        response.destroy();
        finish();
      },
    },
    { highWaterMark: 1 },
  );
}
