/**
 * What a chat's screen is, kept where a restart cannot lose it.
 *
 * One record per chat: the view it shows — screen, params, the messages with
 * their fingerprints, the tokens of buttons too long to carry their address —
 * and the remarks waiting to expire. Nothing else: no history, no copy of
 * application data. The record is read through its schema every time, because
 * storage outlives releases and a record written by another version is not
 * evidence of anything.
 *
 * The storage is grammY's own `StorageAdapter`, so any adapter a grammY bot
 * already uses for sessions (`@grammyjs/storage-*`, `MemorySessionStorage` in
 * tests, or ten lines over the application's database) keeps screens too.
 */
import type { StorageAdapter } from 'grammy';
import { z } from 'zod';
import { createMutationQueue, type MutationQueue } from '../../internal/mutation-queue';

/**
 * How much one chat's record may hold. A view is checked against these when it
 * is rendered, before anything reaches Telegram: a record refused after the
 * calls would leave the chat showing messages nothing tracks.
 */
export const RECORD_LIMITS = {
  /** Messages in one view. */
  messages: 100,
  /** Characters of a message key. */
  key: 64,
  /** Buttons whose address is kept in the record, per view. */
  tokens: 100,
  /** Characters of one kept address. */
  tokenBody: 4_096,
  /** Remarks waiting to expire. */
  remarks: 100,
};

const MessageFingerprintSchema = z
  .object({ content: z.string(), media: z.string(), markup: z.string() })
  .strict();

const ShownMessageSchema = z
  .object({
    key: z.string().min(1).max(RECORD_LIMITS.key),
    id: z.number().int().positive(),
    kind: z.enum(['text', 'rich', 'photo', 'video', 'animation', 'document', 'audio']),
    fingerprint: MessageFingerprintSchema.nullable(),
  })
  .strict();

const ScreenViewStateSchema = z
  .object({
    screen: z.string().min(1).max(64),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    messages: z.array(ShownMessageSchema).min(1).max(RECORD_LIMITS.messages),
    // Twice a view's worth: a plan that stopped keeps the buttons of both renders.
    tokens: z
      .record(z.string(), z.string().max(RECORD_LIMITS.tokenBody))
      .refine((tokens) => Object.keys(tokens).length <= 2 * RECORD_LIMITS.tokens),
  })
  .strict();

const ExpiringNoticeSchema = z
  .object({ id: z.number().int().positive(), at: z.number().int().nonnegative() })
  .strict();

export const ScreenChatStateSchema = z
  .object({
    version: z.literal(1),
    view: ScreenViewStateSchema.nullable(),
    /** Remarks to delete, with the epoch millisecond each expires at. */
    expiring: z.array(ExpiringNoticeSchema).max(RECORD_LIMITS.remarks),
  })
  .strict();

export type ScreenChatState = z.infer<typeof ScreenChatStateSchema>;
export type ScreenViewState = z.infer<typeof ScreenViewStateSchema>;

/** Where chats' screen state survives a restart: grammY's storage contract. */
export type TelegramScreenStorage = StorageAdapter<ScreenChatState>;

export const emptyChatState = (): ScreenChatState => ({
  version: 1,
  view: null,
  expiring: [],
});

export interface ReadChatState {
  readonly state: ScreenChatState;
  /** The stored record did not match the schema and was set aside. */
  readonly discarded: boolean;
}

/**
 * The chat's record. A storage that fails to answer fails the update — reading
 * "nothing" would send a message meant as input to whatever handles text next.
 * A record that does not match this release's schema is set aside and
 * reported: refusing it forever would leave the chat without screens.
 */
export async function readChatState(
  storage: TelegramScreenStorage,
  key: string,
): Promise<ReadChatState> {
  const stored: unknown = await storage.read(key);
  if (stored === undefined) return { state: emptyChatState(), discarded: false };
  const parsed = ScreenChatStateSchema.safeParse(stored);
  return parsed.success
    ? { state: parsed.data, discarded: false }
    : { state: emptyChatState(), discarded: true };
}

export async function writeChatState(
  storage: TelegramScreenStorage,
  key: string,
  state: ScreenChatState,
): Promise<void> {
  if (state.view === null && state.expiring.length === 0) {
    await storage.delete(key);
    return;
  }
  await storage.write(key, ScreenChatStateSchema.parse(state));
}

/**
 * One chat at a time, in arrival order. Two presses in one chat are two
 * read-render-write passes over one record; interleaved, the second would draw
 * over messages the first is deleting. A chat's queue is dropped once it
 * drains, and bounded while it has work: a chat that sends faster than
 * Telegram answers is refused rather than queued without end.
 */
export type ChatQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>;

export function createChatQueue(maxPending: number): ChatQueue {
  const queues = new Map<string, { run: MutationQueue; pending: number }>();
  return async (key, task) => {
    let queue = queues.get(key);
    if (!queue) {
      queue = { run: createMutationQueue(maxPending), pending: 0 };
      queues.set(key, queue);
    }
    const entry = queue;
    entry.pending += 1;
    try {
      return await entry.run(task);
    } finally {
      entry.pending -= 1;
      if (entry.pending === 0 && queues.get(key) === entry) queues.delete(key);
    }
  };
}
