import type { ModelMessage } from 'ai';
import {
  type DeferredAgentToolManifestEntry,
  DeferredAgentToolReceiptSchema,
  type DeferredResolvedSurface,
} from './deferred-tool-types';

const encoder = new TextEncoder();
export function utf8Bytes(value: unknown): number {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}
export function positive(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
}
export function uniqueKnown(
  names: readonly string[],
  surface: DeferredResolvedSurface,
): { names: string[]; rejected: number } {
  const seen = new Set<string>();
  let rejected = 0;
  for (const name of names) {
    if (seen.has(name) || !surface.byName.has(name)) {
      rejected += 1;
      continue;
    }
    seen.add(name);
  }
  return { names: [...seen], rejected };
}
export function schemaBytes(
  names: readonly string[],
  surface: DeferredResolvedSurface,
): number {
  let bytes = 0;
  for (const name of names) {
    const entry =
      name === surface.searchEntry.name ? surface.searchEntry : surface.byName.get(name);
    if (entry) bytes += utf8Bytes(entry);
  }
  return bytes;
}
export function ranked(
  query: string,
  manifest: readonly DeferredAgentToolManifestEntry[],
): string[] {
  const needle = query.trim().toLocaleLowerCase();
  return manifest
    .map((entry, order) => {
      const name = entry.name.toLocaleLowerCase();
      const description = entry.description.toLocaleLowerCase();
      const score =
        name === needle
          ? 0
          : name.startsWith(needle)
            ? 1
            : name.split(/[_-]/u).some((token) => token.startsWith(needle))
              ? 2
              : name.includes(needle)
                ? 3
                : description.includes(needle)
                  ? 4
                  : 5;
      return { name: entry.name, order, score };
    })
    .filter((entry) => entry.score < 5)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map((entry) => entry.name);
}
export function latestSelection(
  messages: readonly ModelMessage[],
  searchName: string,
  runId: string,
  surface: DeferredResolvedSurface,
  maxSelectedTools: number,
): { selected: string[]; source: 'catalog' | 'durable' } {
  let selected: string[] = [];
  let found = false;
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content === 'string') continue;
    const replacement: string[] = [];
    let validReceipts = 0;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.toolName !== searchName) continue;
      if (part.output.type !== 'json') continue;
      const parsed = DeferredAgentToolReceiptSchema.safeParse(part.output.value);
      if (
        !parsed.success ||
        parsed.data.runId !== runId ||
        parsed.data.surfaceKey !== surface.key
      )
        continue;
      const known = uniqueKnown(parsed.data.selected, surface);
      if (known.rejected > 0 || known.names.length !== parsed.data.selected.length) continue;
      replacement.push(...known.names);
      validReceipts += 1;
    }
    if (validReceipts > 0) {
      const merged = uniqueKnown(replacement, surface).names;
      if (merged.length > maxSelectedTools) continue;
      selected = merged;
      found = true;
    }
  }
  return { selected, source: found ? 'durable' : 'catalog' };
}
