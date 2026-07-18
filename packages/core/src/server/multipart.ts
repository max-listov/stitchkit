import type { ZodType } from 'zod';
import { badRequest } from '../contract';
import { isUnsafeKey } from '../internal/safe-json';

/** A parsed multipart request — the uploaded `file` and the validated `fields`. */
export interface MultipartResult {
  file: File;
  /** Validated when a `fieldsSchema` was given, else the raw decoded fields. */
  fields: unknown;
}

/** Default per-request upload ceiling — override via the `maxBytes` argument. */
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Read a request body into a buffer, aborting once it exceeds `maxBytes`. The
 * read is capped *before* anything is buffered, so an upload with a missing or
 * spoofed `Content-Length` cannot exhaust memory — `req.formData()` alone
 * would buffer the whole body first.
 */
async function readBodyCapped(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        badRequest(`Upload exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

/**
 * Parse a `multipart/form-data` request — extract the file at `fileField` and
 * the remaining fields, then validate them with `fieldsSchema` when given.
 * Rejects with a 400 if the file is missing or the upload exceeds `maxBytes`
 * (default 25 MB).
 *
 * A multipart text field is always a **string** (per the spec) and is handed to
 * the schema as one — the schema decides its type, exactly as with query params:
 * `z.coerce.number()` for a number, `z.stringbool()` for a boolean (NOT
 * `z.coerce.boolean()`, which is `Boolean(str)` — `'false'` would become `true`),
 * and `z.preprocess((v) => JSON.parse(String(v)), Schema)` to opt a field into JSON.
 * Content is never sniffed to guess a type — the contract owns the type, not the
 * value (so an id like `'33111715'` never turns into a number under a `z.string()`).
 */
export async function parseMultipart(
  req: Request,
  fileField: string,
  fieldsSchema?: ZodType<unknown>,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<MultipartResult> {
  // Stream-read with a hard byte cap, then parse the capped buffer — memory is
  // bounded at `maxBytes` regardless of `Content-Length`.
  const body = await readBodyCapped(req, maxBytes);
  const contentType = req.headers.get('content-type') ?? '';
  const formData = await new Response(body, {
    headers: { 'content-type': contentType },
  }).formData();

  const file = formData.get(fileField);
  if (!file || !(file instanceof File)) {
    badRequest(`Missing file field: ${fileField}`);
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === fileField) continue;
    // A field literally named `__proto__` would pollute the prototype chain.
    if (isUnsafeKey(key)) continue;
    // Text fields stay raw strings — the schema coerces (see the doc above).
    // Non-string entries are other `File`s, which are not form fields here.
    if (typeof value === 'string') fields[key] = value;
  }

  return { file, fields: fieldsSchema ? fieldsSchema.parse(fields) : fields };
}
