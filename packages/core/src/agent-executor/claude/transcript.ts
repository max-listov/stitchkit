import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { errnoOf } from '../../internal/errno';
import type { ExecutorEngine } from '../hello';
import { type ExecutorProfileConfig, engineProfile } from '../profile';

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Where Claude Code keeps a session's transcript in a profile:
 * `<home>/projects/<cwd with every character but letters, digits and "-"
 * replaced by "-">/<sessionId>.jsonl`, as observed on the CLI.
 */
export function claudeTranscriptPath(input: {
  home: string;
  cwd: string;
  sessionId: string;
}): string {
  if (!SAFE_SESSION_ID.test(input.sessionId)) {
    throw new TypeError(`Invalid Claude sessionId: ${input.sessionId}`);
  }
  return join(
    input.home,
    'projects',
    input.cwd.replace(/[^A-Za-z0-9-]/g, '-'),
    `${input.sessionId}.jsonl`,
  );
}

/** How much of a transcript one search reads; a session past it is read from its end. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Whether the transcript holds a record with this `uuid` — the id the
 * executor gave the input. Found means the engine took the input; not found
 * means it has no record of it, which is not the same as "never sent": the
 * caller settles that as `uncertain`, never by sending again.
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
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_SCAN_BYTES);
    const total = size - start;
    const buffer = new Uint8Array(total);
    let offset = 0;
    while (offset < total) {
      const { bytesRead } = await handle.read(buffer, offset, total - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const text = new TextDecoder().decode(buffer.subarray(0, offset));
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const record: unknown = JSON.parse(trimmed);
        if (
          typeof record === 'object' &&
          record !== null &&
          Reflect.get(record, 'uuid') === uuid
        )
          return true;
      } catch {
        // Ignore truncated leading line when reading from MAX_SCAN_BYTES tail or non-JSON noise.
      }
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
