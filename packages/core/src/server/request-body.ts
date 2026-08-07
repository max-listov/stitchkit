import { badRequest } from '../contract';

export function assertJsonBodyLimit(maxBytes: number | undefined, owner: string): void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error(`${owner} must be a positive safe integer, received ${maxBytes}`);
  }
}

/** Read UTF-8 request text, optionally stopping before a configured byte cap is exceeded. */
export async function readRequestText(req: Request, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return req.text();
  assertJsonBodyLimit(maxBytes, 'maxJsonBodyBytes');

  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        badRequest(`JSON body exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
