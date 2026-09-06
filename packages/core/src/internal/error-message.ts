import { isRecord } from './typed';

/** The message a thrown value carries, or `''` when it carries none. */
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return '';
}
