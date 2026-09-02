/**
 * Multipart field encoding for the client — the platform-sensitive corner of
 * `client.ts`, split out so the request-building logic there reads without it.
 *
 * Internal: none of this is public surface. The React Native descriptor path is
 * the only genuinely subtle part, and keeping it together with its two guards
 * makes that subtlety readable in one screen.
 */
import type { FileDescriptor, MultipartDescriptor, MultipartFile } from '../contract';
import { refuseLocally } from './http';

/**
 * A React Native / Expo file descriptor — a plain `{ uri, name, type }` object
 * (all strings), not a `Blob`. Narrowed tightly so an unrelated object never
 * matches: it must carry exactly those three string fields and not be a `Blob`.
 */
function isFileDescriptor(value: unknown): value is FileDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Blob) &&
    'uri' in value &&
    typeof value.uri === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

/** A multipart file field — a `Blob` (web / Bun) or a platform descriptor (RN). */
export function isMultipartFile(value: unknown): value is MultipartFile {
  return value instanceof Blob || isFileDescriptor(value);
}

/**
 * Append the file part. `FormData.append` is typed `(name, value: string | Blob)`
 * by the DOM lib, but on React Native attaching a `{ uri, name, type }`
 * descriptor is the native way to send a file (RN streams it from disk). Route
 * through a structural type whose `append` also accepts a `FileDescriptor` —
 * method-parameter bivariance lets the real `FormData` satisfy it, so the
 * descriptor path stays cast-free. Web / Bun still pass a `Blob`.
 */
export function appendMultipartFile(form: FormData, field: string, file: MultipartFile): void {
  const sink: { append(name: string, value: string | MultipartFile): void } = form;
  sink.append(field, file);
}

export function appendFormFields(
  formData: FormData,
  values: Record<string, unknown>,
  skipKeys: Set<string>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (skipKeys.has(key) || value === undefined || value === null) continue;
    formData.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

/** Build one FormData body from the contract's multipart descriptor. */
export function buildMultipartForm(
  descriptor: MultipartDescriptor,
  values: Record<string, unknown>,
): FormData {
  const formData = new FormData();
  const fileFields = new Set(Object.keys(descriptor.files));

  for (const [field, policy] of Object.entries(descriptor.files)) {
    const value = values[field];
    if (value === undefined) {
      if (policy.required !== false) {
        throw refuseLocally(field, `Missing multipart file field: ${field}`);
      }
      continue;
    }
    if (policy.multiple === true) {
      if (!Array.isArray(value) || value.length === 0) {
        throw refuseLocally(
          field,
          `Multipart file field "${field}" must be a non-empty array`,
        );
      }
      for (const file of value) {
        if (!isMultipartFile(file)) {
          throw refuseLocally(field, `Invalid multipart file field: ${field}`);
        }
        appendMultipartFile(formData, field, file);
      }
      continue;
    }
    if (!isMultipartFile(value)) {
      throw refuseLocally(field, `Invalid multipart file field: ${field}`);
    }
    appendMultipartFile(formData, field, value);
  }

  appendFormFields(formData, values, fileFields);
  return formData;
}
