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

import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

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
): Promise<void> {
  const temporary = `${files.recipients}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(recipients));
  await rename(temporary, files.recipients);
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

export function appendJournal(files: BroadcastFiles, line: JournalLine): Promise<void> {
  return appendFile(files.journal, `${JSON.stringify(line)}\n`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
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
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(files.lock, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(files.lock, { force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const owner = Number.parseInt(await readFile(files.lock, 'utf8').catch(() => ''), 10);
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) {
        throw new Error('Telegram broadcast is already running in another process');
      }
      await rm(files.lock, { force: true });
    }
  }
  throw new Error('Telegram broadcast lock could not be taken');
}
