import { realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errnoOf } from '../../internal/errno';
import type { ExecutorEngine } from '../hello';
import { type ExecutorProfileConfig, engineProfile } from '../profile';

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function stripTrailingSlashes(path: string): string {
  const stripped = path.replace(/\/+$/, '');
  return stripped.length === 0 && path.startsWith('/') ? '/' : stripped;
}

/**
 * Resolve `cwd` to its canonical POSIX `realpath`, matching Claude Code's own
 * project-directory encoding on symlinked workspaces (such as macOS `/var` ->
 * `/private/var` or `/tmp` -> `/private/tmp`). When a leaf directory does not
 * exist yet (`ENOENT` / `ENOTDIR`), resolve its nearest existing ancestor and
 * append the remaining segments deterministically. Other filesystem errors
 * (`EACCES`, `ELOOP`) are rethrown so `findInput` fails closed rather than
 * probing a non-canonical path and reporting a false absence.
 */
function canonicalClaudeCwd(cwd: string): string {
  if (cwd.length === 0) return cwd;
  const normalized = stripTrailingSlashes(cwd);
  const missingTail: string[] = [];
  let probe = normalized;
  for (;;) {
    try {
      const resolved = realpathSync(probe);
      return missingTail.length === 0 ? resolved : join(resolved, ...missingTail.reverse());
    } catch (error) {
      const code = errnoOf(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(probe);
      if (parent === probe) return normalized;
      missingTail.push(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Where Claude Code keeps a session's transcript in a profile:
 * `<home>/projects/<canonical realpath(cwd) with every character but letters,
 * digits and "-" replaced by "-">/<sessionId>.jsonl`, as observed on the CLI.
 */
export function claudeTranscriptPath(input: {
  home: string;
  cwd: string;
  sessionId: string;
}): string {
  if (!SAFE_SESSION_ID.test(input.sessionId)) {
    throw new TypeError(`Invalid Claude sessionId: ${input.sessionId}`);
  }
  const canonicalCwd = canonicalClaudeCwd(input.cwd);
  return join(
    input.home,
    'projects',
    canonicalCwd.replace(/[^A-Za-z0-9-]/g, '-'),
    `${input.sessionId}.jsonl`,
  );
}

/**
 * Bounded per-record memory ceiling while streaming the full transcript (16 MiB).
 * Accommodates a 5 MiB base64-encoded image turn (~6.7 MiB JSON) with headroom while
 * refusing unbounded allocation on corrupted lines.
 */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const INITIAL_RECORD_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

type LineVerdict = 'match' | 'other' | 'invalid';

function classifyTranscriptLine(bytes: Uint8Array, uuid: string): LineVerdict {
  const end =
    bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
  if (end === 0) return 'other';
  let record: unknown;
  try {
    record = JSON.parse(UTF8_STRICT.decode(bytes.subarray(0, end)));
  } catch {
    return 'invalid';
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return 'invalid';
  if (Reflect.get(record, 'type') !== 'user') return 'other';
  const recordUuid = Reflect.get(record, 'uuid');
  if (typeof recordUuid !== 'string') return 'invalid';
  return recordUuid === uuid ? 'match' : 'other';
}

/**
 * Whether the transcript holds a `user` record with this `uuid` — the id the
 * executor gave the input. Streams the whole file with bounded memory:
 * - Found (`true`): a top-level `type: 'user'` record carries `uuid`.
 * - Not found (`false`): either the transcript does not exist (`ENOENT`) or every
 *   record in the complete file was decoded without finding a matching `user` record.
 * - Unknown (throws): I/O failure, malformed/non-UTF-8 record, `user` record without a
 *   string `uuid`, or a record over the 16 MiB cap prevented proving absence.
 */
export async function claudeTranscriptHasUuid(path: string, uuid: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false;
    throw error;
  }
  try {
    const chunk = new Uint8Array(READ_CHUNK_BYTES);
    let lineBuf = new Uint8Array(INITIAL_RECORD_BYTES);
    let lineLen = 0;
    let lineOverflow = false;
    let lineNumber = 1;
    let problem: string | undefined;

    const appendSlice = (src: Uint8Array, start: number, end: number): void => {
      if (lineOverflow || end <= start) return;
      const add = end - start;
      const needed = lineLen + add;
      if (needed > MAX_RECORD_BYTES) {
        lineOverflow = true;
        lineLen = 0;
        return;
      }
      if (needed > lineBuf.length) {
        let nextCap = lineBuf.length;
        while (nextCap < needed) nextCap = Math.min(MAX_RECORD_BYTES, nextCap * 2);
        const grown = new Uint8Array(nextCap);
        grown.set(lineBuf.subarray(0, lineLen));
        lineBuf = grown;
      }
      lineBuf.set(src.subarray(start, end), lineLen);
      lineLen = needed;
    };

    const finishLine = (): boolean => {
      const currentLine = lineNumber;
      lineNumber += 1;
      if (lineOverflow) {
        problem ??= `line ${currentLine} exceeds the ${MAX_RECORD_BYTES}-byte record limit`;
        lineOverflow = false;
        lineLen = 0;
        return false;
      }
      const verdict = classifyTranscriptLine(lineBuf.subarray(0, lineLen), uuid);
      lineLen = 0;
      if (verdict === 'match') return true;
      if (verdict === 'invalid') {
        problem ??= `line ${currentLine} could not be parsed as a valid transcript record`;
      }
      return false;
    };

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      let start = 0;
      for (let i = 0; i < bytesRead; i += 1) {
        if (chunk[i] === 0x0a) {
          appendSlice(chunk, start, i);
          if (finishLine()) return true;
          start = i + 1;
        }
      }
      appendSlice(chunk, start, bytesRead);
    }
    if ((lineLen > 0 || lineOverflow) && finishLine()) return true;
    if (problem !== undefined) {
      throw new Error(
        `Claude transcript ${path} could not prove absence of input: ${problem}`,
      );
    }
    return false;
  } finally {
    await handle.close();
  }
}

/**
 * Whether the session's transcript is there to resume. Only `ENOENT` means "no
 * transcript"; any other failure to open it is thrown, so an unreadable session is
 * refused rather than started again under the same id.
 */
export async function claudeTranscriptExists(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false;
    throw error;
  }
  await handle.close();
  return true;
}

/** Reconcile a Claude turn input by scanning the profile's transcript for its client UUID. */
export async function findTranscriptInput(
  engine: Extract<ExecutorEngine, 'claude-cli' | 'claude-sdk'>,
  input: {
    profile: ExecutorProfileConfig;
    cwd: string;
    nativeThreadId: string;
    clientId: string;
  },
): Promise<boolean> {
  const profile = engineProfile(engine, input.profile);
  return claudeTranscriptHasUuid(
    claudeTranscriptPath({
      home: profile.home,
      cwd: input.cwd,
      sessionId: input.nativeThreadId,
    }),
    input.clientId,
  );
}
