/**
 * The durable half of a broadcast: who it is for, and what happened to each.
 *
 * Two files per broadcast name. The recipients are written once, atomically,
 * the first time the broadcast runs — the audience of a resumed broadcast is
 * the audience it started with, not whoever matches the query today. Progress
 * is an append-only journal: a line before each send and a line after it, so
 * recording one send costs one short append instead of rewriting a state file
 * that grows with the audience.
 *
 * The line before the send is what makes a crash honest. A recipient whose
 * last line says `sending` may or may not have received the message; a resume
 * records them as `uncertain` and does not send again, because a second copy
 * of a broadcast is the failure a subscriber notices.
 */

import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../internal/atomic-file';
import { attemptExclusiveLock, type HeldExclusiveLock } from '../internal/exclusive-lock';

export const TelegramBroadcastOutcomeSchema = z.enum([
  'delivered',
  'unreachable',
  'failed',
  'uncertain',
]);
export type TelegramBroadcastOutcome = z.infer<typeof TelegramBroadcastOutcomeSchema>;

const ChatIdSchema = z.union([z.number().int(), z.string().min(1).max(64)]);
export type TelegramBroadcastRecipient = z.infer<typeof ChatIdSchema>;

const RecipientsSchema = z.array(ChatIdSchema);

const JournalLineSchema = z.union([
  z.object({ i: z.number().int().nonnegative(), s: z.enum(['sending', 'released']) }).strict(),
  z
    .object({
      i: z.number().int().nonnegative(),
      o: TelegramBroadcastOutcomeSchema,
      r: z.string().max(64).optional(),
    })
    .strict(),
]);
type JournalLine = z.infer<typeof JournalLineSchema>;

/** Per recipient index: the outcome, or `sending` for a send whose end is unknown. */
export type BroadcastProgress = Map<number, TelegramBroadcastOutcome | 'sending'>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertBroadcastName(name: string): void {
  if (!NAME.test(name)) {
    throw new TypeError(
      'Telegram broadcast name must be 1–128 of [A-Za-z0-9._-] and start with a letter or digit',
    );
  }
}

const absent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export interface BroadcastFiles {
  readonly recipients: string;
  readonly journal: string;
  readonly lock: string;
}

export function broadcastFiles(directory: string, name: string): BroadcastFiles {
  return {
    recipients: join(directory, `${name}.recipients.json`),
    journal: join(directory, `${name}.journal.ndjson`),
    lock: join(directory, `${name}.lock`),
  };
}

export async function readRecipients(
  files: BroadcastFiles,
): Promise<TelegramBroadcastRecipient[] | null> {
  try {
    return RecipientsSchema.parse(JSON.parse(await readFile(files.recipients, 'utf8')));
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

export async function writeRecipients(
  files: BroadcastFiles,
  recipients: readonly TelegramBroadcastRecipient[],
  lock: HeldExclusiveLock,
): Promise<void> {
  await lock.assertHeld();
  await writeFileAtomic(files.recipients, JSON.stringify(recipients), {
    replace: false,
    durability: 'directory',
  });
}

/** Persist the journal directory entry before its first sending intent can be acknowledged. */
export async function prepareJournal(
  files: BroadcastFiles,
  lock: HeldExclusiveLock,
): Promise<void> {
  await lock.assertHeld();
  try {
    await writeFileAtomic(files.journal, '', { replace: false, durability: 'directory' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

/**
 * Replay the journal. A torn last line — the process died mid-append — is
 * skipped; every complete line before it stands.
 */
export async function readProgress(files: BroadcastFiles): Promise<BroadcastProgress> {
  const progress: BroadcastProgress = new Map();
  let text: string;
  try {
    text = await readFile(files.journal, 'utf8');
  } catch (error) {
    if (absent(error)) return progress;
    throw error;
  }
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let line: JournalLine;
    try {
      line = JournalLineSchema.parse(JSON.parse(raw));
    } catch {
      continue;
    }
    if ('o' in line) progress.set(line.i, line.o);
    else if (line.s === 'sending') progress.set(line.i, 'sending');
    else progress.delete(line.i);
  }
  return progress;
}

export async function appendJournal(
  files: BroadcastFiles,
  line: JournalLine,
  lock: HeldExclusiveLock,
): Promise<void> {
  await lock.assertHeld();
  const handle = await open(files.journal, 'a', 0o600);
  try {
    await lock.assertHeld();
    await handle.writeFile(`${JSON.stringify(line)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * One runner per broadcast name. Two would each read the same pending
 * recipients and send them twice. A lock left by a process that is gone is
 * taken over.
 */
export async function lockBroadcast(
  directory: string,
  files: BroadcastFiles,
): Promise<HeldExclusiveLock> {
  await mkdir(directory, { recursive: true });
  const attempt = await attemptExclusiveLock(files.lock, {
    mode: 0o600,
    reclaim: true,
    ownerlessGraceMs: null,
  });
  if ('held' in attempt) return attempt.held;
  throw new Error('Telegram broadcast is already running or its lock owner is unknown', {
    cause: attempt.diagnosis?.cause ?? attempt.error,
  });
}
