import { z } from 'zod';

function isManagedFilePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** Canonical POSIX-style path relative to a managed file boundary. */
export const ManagedFilePathSchema = z
  .string()
  .refine(isManagedFilePath, 'expected a canonical relative managed-file path');

/** Transport-safe identity and metadata for a file owned by a managed boundary. */
export const ManagedFileRefSchema = z.object({
  path: ManagedFilePathSchema,
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

export type ManagedFilePath = z.infer<typeof ManagedFilePathSchema>;
export type ManagedFileRef = z.infer<typeof ManagedFileRefSchema>;
