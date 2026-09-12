/**
 * Character-boundary arithmetic for byte-bounded windows.
 *
 * A window cut at `offset + maxBytes` lands wherever the bytes fall, and the
 * cut regularly lands inside a multi-byte character — Russian text makes that
 * the common case, not the exception. A fatal `TextDecoder` refuses such a
 * slice, so a bounded read of a perfectly valid file answered
 * `INTERNAL_SERVER_ERROR` for some offsets and succeeded for others. The window
 * is aligned here, before any decoder sees it.
 *
 * The alignment never returns an empty window for a non-empty read: when the
 * requested end falls inside a sequence, it extends to that sequence's last
 * byte, provided the caller supplied those bytes. Without the extension a
 * window smaller than one character would make no progress and the reader would
 * loop on the same offset — a silent hang where the old code at least refused.
 */

/** Byte length of the sequence led by `lead`, or `undefined` when it is not a lead. */
function sequenceLength(lead: number): number | undefined {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return undefined;
}

/**
 * The largest `end' <= start + limit` that ends on a character boundary.
 *
 * When the byte before the cut begins a sequence that runs past it, `end` moves
 * back to that sequence's lead — or forward to its final byte when the buffer
 * holds it. A sequence truncated at the end of the buffer is left for the fatal
 * decoder to refuse, so a genuinely broken file still names its cause.
 */
export function utf8AlignedEnd(data: Uint8Array, start: number, limit: number): number {
  const safe = Math.max(start, Math.min(start + limit, data.byteLength));
  for (let back = 1; back <= 4 && safe - back >= start; back += 1) {
    const byte = data[safe - back] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const length = sequenceLength(byte);
    if (length === undefined) return safe;
    if (back >= length) return safe;
    const sequenceEnd = safe - back + length;
    return sequenceEnd <= data.byteLength ? sequenceEnd : safe - back;
  }
  return safe;
}

/** The smallest `start' >= start` that begins on a character boundary. */
export function utf8AlignedStart(data: Uint8Array, start: number, end: number): number {
  let safe = Math.max(0, Math.min(start, end));
  while (safe < end && ((data[safe] as number) & 0xc0) === 0x80) safe += 1;
  return safe;
}
