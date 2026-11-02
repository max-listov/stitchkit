/** When a refusal is read as the bot's own limit rather than one chat's. */
export interface OutboundPausePolicy {
  readonly tokenPauseChats: number;
  readonly tokenPauseWindowMs: number;
}

/** A token's pauses: its own, and one per chat that got a 429. */
export interface OutboundPauses {
  /** The instant `chat`, or the token when `chat` is undefined, may send again. */
  resumesAt(chat: string | undefined): number;
  pauseToken(milliseconds: number): void;
  /** One chat's refusal, counted towards reading it as the token's. */
  pauseChat(chat: string, milliseconds: number): void;
  pausedForMs(): number;
  pausedChats(): number;
}

export function createOutboundPauses(
  { tokenPauseChats, tokenPauseWindowMs }: OutboundPausePolicy,
  now: () => number,
  onPause: () => void,
): OutboundPauses {
  const chatPauses = new Map<string, number>();
  /** The chats refused lately, each with the moment of its last refusal. */
  const refusedChats = new Map<string, number>();
  let pausedUntil = Number.NEGATIVE_INFINITY;

  /** A pause as an instant; an infinite wait is the strongest there is, never a no-op. */
  const pauseEnd = (milliseconds: number): number => {
    if (Number.isNaN(milliseconds) || milliseconds < 0) {
      throw new RangeError('pause must be a non-negative number of milliseconds');
    }
    return now() + (Number.isFinite(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER);
  };

  const pauseToken = (milliseconds: number): void => {
    pausedUntil = Math.max(pausedUntil, pauseEnd(milliseconds));
    onPause();
  };

  const forgetExpired = (current: number): void => {
    for (const [chat, until] of chatPauses) if (until <= current) chatPauses.delete(chat);
    for (const [chat, at] of refusedChats) {
      if (current - at > tokenPauseWindowMs) refusedChats.delete(chat);
    }
  };

  return {
    resumesAt: (chat) =>
      Math.max(
        pausedUntil,
        (chat === undefined ? undefined : chatPauses.get(chat)) ?? Number.NEGATIVE_INFINITY,
      ),
    pauseToken,
    pauseChat(chat, milliseconds) {
      const until = pauseEnd(milliseconds);
      const current = now();
      forgetExpired(current);
      chatPauses.set(chat, Math.max(chatPauses.get(chat) ?? until, until));
      refusedChats.set(chat, current);
      onPause();
      if (refusedChats.size < tokenPauseChats) return;
      refusedChats.clear();
      pauseToken(milliseconds);
    },
    pausedForMs: () => Math.max(0, pausedUntil - now()),
    pausedChats() {
      forgetExpired(now());
      return chatPauses.size;
    },
  };
}
