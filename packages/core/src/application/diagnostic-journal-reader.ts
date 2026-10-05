import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { openJournalFile } from './diagnostic-journal-open';
import {
  createDiagnosticJournalReadResultSchema,
  type DiagnosticJournalAnomaly,
  type DiagnosticJournalReadResult,
} from './diagnostic-journal-read-contract';

/**
 * Config for `readDiagnosticJournal`: the files to read in order, the schema each event must
 * match, and a per-line byte limit.
 */
export interface DiagnosticJournalReaderConfig<SCHEMA extends z.ZodType> {
  /** Explicit operator-owned files, read in this order; missing files are I/O errors. */
  readonly paths: readonly string[];
  readonly eventSchema: SCHEMA;
  /** Maximum JSONL body bytes retained in memory, excluding its LF. */
  readonly maxLineBytes: number;
  readonly signal?: AbortSignal;
}

export interface LineLocation {
  readonly file: string;
  readonly offset: number;
  readonly line: number;
  readonly bytes: number;
  readonly terminated: boolean;
  readonly position: 'tail' | 'interior';
}

export function decodeLine<SCHEMA extends z.ZodType>(
  schema: ReturnType<typeof createDiagnosticJournalReadResultSchema<SCHEMA>>,
  location: LineLocation,
  body: Uint8Array | undefined,
): DiagnosticJournalReadResult<SCHEMA>[] {
  const anomaly = (
    reason: DiagnosticJournalAnomaly['reason'],
    skippedBytes = location.bytes,
  ) =>
    schema.parse({
      type: 'anomaly',
      anomaly: {
        file: location.file,
        offset: location.offset,
        line: location.line,
        reason,
        position: location.position,
        terminated: location.terminated,
        skippedBytes,
      },
    });
  if (body === undefined) return [anomaly('oversized-line')];
  if (body.includes(0)) return [anomaly('nul-byte')];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return [anomaly('invalid-utf8')];
  }
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return [anomaly(location.terminated ? 'invalid-json' : 'unterminated-line')];
  }
  const parsed = schema.safeParse({
    type: 'frame',
    file: location.file,
    offset: location.offset,
    line: location.line,
    bytes: location.bytes,
    frame,
  });
  if (!parsed.success) {
    const frameInvalid = parsed.error.issues.some(
      (issue) => issue.path[0] !== 'frame' || issue.path[1] !== 'event',
    );
    return [anomaly(frameInvalid ? 'invalid-frame' : 'invalid-event')];
  }
  // A complete JSON frame without LF is useful evidence, with an explicit tail warning.
  return location.terminated ? [parsed.data] : [anomaly('unterminated-line', 0), parsed.data];
}

/**
 * One finite file snapshot at a time. Corrupt rows are data; filesystem failures throw.
 */
export async function* readDiagnosticJournal<SCHEMA extends z.ZodType>(
  config: DiagnosticJournalReaderConfig<SCHEMA>,
): AsyncGenerator<DiagnosticJournalReadResult<SCHEMA>, void, unknown> {
  const maxLineBytes = z.number().int().positive().parse(config.maxLineBytes);
  if (config.paths.length === 0)
    throw new TypeError('Diagnostic journal reader needs at least one path');
  for (const path of config.paths) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new TypeError('Diagnostic journal reader paths must be normalized and absolute');
    }
  }
  const schema = createDiagnosticJournalReadResultSchema(config.eventSchema);
  for (const file of config.paths) {
    config.signal?.throwIfAborted();
    const { handle, size } = await openJournalFile(file);
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let offset = 0;
      let lineOffset = 0;
      let line = 1;
      let lineBytes = 0;
      let oversized = false;
      let parts: Buffer[] = [];
      while (offset < size) {
        config.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, size - offset),
          offset,
        );
        if (bytesRead === 0)
          throw new Error(`Diagnostic journal file was truncated during read: ${file}`);
        let start = 0;
        while (start < bytesRead) {
          config.signal?.throwIfAborted();
          const found = chunk.indexOf(10, start);
          const terminated = found >= start && found < bytesRead;
          const end = terminated ? found : bytesRead;
          lineBytes += end - start;
          if (lineBytes > maxLineBytes) {
            oversized = true;
            parts = [];
          } else if (!oversized && end > start) {
            parts.push(Buffer.from(chunk.subarray(start, end)));
          }
          start = end + (terminated ? 1 : 0);
          if (terminated) {
            const nextOffset = offset + start;
            yield* decodeLine(
              schema,
              {
                file,
                offset: lineOffset,
                line,
                bytes: lineBytes + 1,
                terminated: true,
                position: nextOffset === size ? 'tail' : 'interior',
              },
              oversized ? undefined : Buffer.concat(parts, lineBytes),
            );
            lineOffset = nextOffset;
            line += 1;
            lineBytes = 0;
            oversized = false;
            parts = [];
          }
        }
        offset += bytesRead;
      }
      if (lineBytes > 0) {
        yield* decodeLine(
          schema,
          {
            file,
            offset: lineOffset,
            line,
            bytes: lineBytes,
            terminated: false,
            position: 'tail',
          },
          oversized ? undefined : Buffer.concat(parts, lineBytes),
        );
      }
    } finally {
      await handle.close();
    }
  }
}
