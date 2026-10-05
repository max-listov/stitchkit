import { z } from 'zod';
import { closeAfter } from '../internal/close-after';
import { openJournalFile } from './diagnostic-journal-open';
import {
  createDiagnosticJournalReadResultSchema,
  type DiagnosticJournalReadResult,
} from './diagnostic-journal-read-contract';
import { decodeLine, type LineLocation } from './diagnostic-journal-reader';

const SCAN_CHUNK_BYTES = 1024 * 1024;
const jsonSchema = z.json();
const resultSchema = createDiagnosticJournalReadResultSchema(jsonSchema);

/**
 * The result of reading only the final line of each file, as the full reader
 * would have reported it. Nothing before that line is parsed or validated: a
 * file is read once in large blocks to count its line feeds, which is what puts
 * the line number and byte offset on a finding.
 */
export async function* readDiagnosticJournalTails(
  paths: readonly string[],
  maxLineBytes: number,
): AsyncGenerator<DiagnosticJournalReadResult<typeof jsonSchema>> {
  for (const file of paths) {
    const { handle, size } = await openJournalFile(file);
    const last = await closeAfter(handle, async () => {
      if (size === 0) return undefined;
      const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
      let lineFeeds = 0;
      let lastFeed = -1;
      let previousFeed = -1;
      for (let offset = 0; offset < size; ) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, size - offset),
          offset,
        );
        if (bytesRead === 0)
          throw new Error(`Diagnostic journal file was truncated during read: ${file}`);
        const block = chunk.subarray(0, bytesRead);
        for (let at = block.indexOf(10); at !== -1; at = block.indexOf(10, at + 1)) {
          lineFeeds += 1;
          previousFeed = lastFeed;
          lastFeed = offset + at;
        }
        offset += bytesRead;
      }
      const terminated = lastFeed === size - 1;
      const start = (terminated ? previousFeed : lastFeed) + 1;
      const length = (terminated ? size - 1 : size) - start;
      const location: LineLocation = {
        file,
        offset: start,
        line: terminated ? lineFeeds : lineFeeds + 1,
        bytes: length + (terminated ? 1 : 0),
        terminated,
        position: 'tail',
      };
      if (length > maxLineBytes) return { location, body: undefined };
      const body = Buffer.alloc(length);
      for (let filled = 0; filled < length; ) {
        const { bytesRead } = await handle.read(body, filled, length - filled, start + filled);
        if (bytesRead === 0)
          throw new Error(`Diagnostic journal file was truncated during read: ${file}`);
        filled += bytesRead;
      }
      return { location, body };
    });
    if (last) yield* decodeLine<typeof jsonSchema>(resultSchema, last.location, last.body);
  }
}
