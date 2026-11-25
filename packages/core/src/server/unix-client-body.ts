import type { IncomingMessage } from 'node:http';
import { abortReason, withLinkedAbortSignals } from '../internal/abort-race';
import { readBoundedBody } from '../internal/bounded-body';
import { UnixClientTransportError } from '../internal/unix-client-error';

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
  closeSignal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (closeSignal?.aborted) throw abortReason(closeSignal);
  if (request.signal.aborted) throw abortReason(request.signal);
  const body = request.body;
  if (!body) return undefined;
  const tooLarge = () =>
    new UnixClientTransportError(
      'UNIX_REQUEST_TOO_LARGE',
      `Unix request body exceeds the ${maxBytes} byte limit`,
      'not-dispatched',
    );
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw tooLarge();
  return withLinkedAbortSignals(closeSignal, request.signal, (signal) =>
    readBoundedBody(body, {
      maxBytes,
      signal,
      limitError: tooLarge,
      abortError: (reason) => reason,
    }),
  );
}

export function exceedsDeclaredResponseBytes(
  headers: Headers,
  maxResponseBytes: number | undefined,
): boolean {
  if (maxResponseBytes === undefined) return false;
  const declared = headers.get('content-length');
  return declared !== null && /^\d+$/.test(declared) && Number(declared) > maxResponseBytes;
}

export function cloneRequestBodyBuffer(body: Uint8Array | undefined): ArrayBuffer | undefined {
  if (body === undefined) return undefined;
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

export function incomingResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
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
