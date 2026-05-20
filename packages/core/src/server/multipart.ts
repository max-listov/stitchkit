import type { ZodType } from 'zod';
import { badRequest } from '../contract';

/** A parsed multipart request — the uploaded `file` and the validated `fields`. */
export interface MultipartResult {
  file: File;
  fields: Record<string, unknown>;
}

/** Default per-request upload ceiling — override via the `maxBytes` argument. */
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Parse a `multipart/form-data` request — extract the file at `fileField` and
 * the remaining fields (each JSON-decoded, then validated by `fieldsSchema`
 * when given). Rejects with a 400 if the file is missing or the upload exceeds
 * `maxBytes` (default 25 MB).
 */
export async function parseMultipart(
  req: Request,
  fileField: string,
  fieldsSchema?: ZodType<unknown>,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<MultipartResult> {
  // Reject oversized uploads up front — `req.formData()` buffers the whole
  // body in memory, so an unbounded upload is an OOM vector.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    badRequest(`Upload exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  const formData = await req.formData();

  const file = formData.get(fileField);
  if (!file || !(file instanceof File)) {
    badRequest(`Missing file field: ${fileField}`);
  }
  // The real ceiling — `Content-Length` above is only a cheap fast-path and
  // can be absent or spoofed; the parsed file size is authoritative.
  if (file.size > maxBytes) {
    badRequest(`Upload exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }

  const fields: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key === fileField) continue;
    if (typeof value === 'string') {
      try {
        fields[key] = JSON.parse(value);
      } catch {
        fields[key] = value;
      }
    }
  }

  const parsed = fieldsSchema ? fieldsSchema.parse(fields) : fields;

  return { file, fields: parsed as Record<string, unknown> };
}
