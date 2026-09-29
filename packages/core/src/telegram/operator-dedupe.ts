/**
 * Repeats and storms held back before they reach a person.
 *
 * One failure in a loop is a hundred identical alerts, and a hundred alerts
 * is a muted chat — after which the one that mattered is not read either. So
 * the same message, by fingerprint, goes once per window and the next one
 * that goes says how many were held back; past a budget per window the rest
 * are counted and the count rides on the first message after. The operator
 * channel uses it through its `dedupe` option; it is exported for senders of
 * their own.
 */

export interface TelegramOperatorDedupe<TTopic extends string> {
  /** Default 600 000 — ten minutes. */
  readonly windowMs?: number;
  /** Messages sent per window, whatever their fingerprint. Default 20. */
  readonly maxPerWindow?: number;
  /**
   * What makes two messages the same. Default: the topic and the text with
   * numbers, UUIDs and long identifiers blanked — they differ between two
   * occurrences of one failure without making it another.
   */
  readonly fingerprint?: (text: string, topic: TTopic | undefined) => string;
  /** The line added to a message after `count` of its repeats were held back. */
  readonly repeatedLine?: (count: number) => string;
  /** The line added to the first message after `count` were held back by the budget. */
  readonly overBudgetLine?: (count: number) => string;
  /** Default `Date.now`. */
  readonly now?: () => number;
}

function defaultFingerprint(text: string, topic: string | undefined): string {
  const blanked = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\b[a-z0-9]{20,}\b/gi, '#')
    .replace(/\d+/g, '#');
  return `${topic ?? ''}\u0000${blanked.slice(0, 300)}`;
}

/** Send `text` — the message with its held-back counts — or hold it back, with why. */
export type TelegramOperatorDedupeVerdict =
  | { readonly send: true; readonly text: string }
  | { readonly send: false; readonly reason: 'repeated' | 'over-budget' };

/**
 * The dedupe window on its own, for an application that sends alerts itself —
 * its own bot, its own retry — and wants only the decision: whether this
 * message goes, and the text it goes with.
 */
export function createTelegramOperatorDedupe<TTopic extends string = never>(
  options: TelegramOperatorDedupe<TTopic> = {},
): (text: string, topic?: TTopic) => TelegramOperatorDedupeVerdict {
  const windowMs = options.windowMs ?? 600_000;
  const maxPerWindow = options.maxPerWindow ?? 20;
  const fingerprint = options.fingerprint ?? defaultFingerprint;
  const now = options.now ?? Date.now;
  const repeatedLine =
    options.repeatedLine ?? ((count: number) => `(+${count} more like this)`);
  const overBudgetLine =
    options.overBudgetLine ?? ((count: number) => `(+${count} more messages over the limit)`);
  const recent = new Map<string, { sentAt: number; held: number }>();
  let windowStart = Number.NEGATIVE_INFINITY;
  let sentInWindow = 0;
  let overBudget = 0;
  return (text, topic) => {
    const at = now();
    const key = fingerprint(text, topic);
    const previous = recent.get(key);
    if (previous && at - previous.sentAt < windowMs) {
      previous.held += 1;
      return { send: false, reason: 'repeated' };
    }
    if (at - windowStart >= windowMs) {
      windowStart = at;
      sentInWindow = 0;
    }
    if (sentInWindow >= maxPerWindow) {
      overBudget += 1;
      return { send: false, reason: 'over-budget' };
    }
    sentInWindow += 1;
    for (const [stale, entry] of recent) {
      if (at - entry.sentAt >= windowMs) recent.delete(stale);
    }
    recent.set(key, { sentAt: at, held: 0 });
    const lines = [text];
    if (previous?.held) lines.push(repeatedLine(previous.held));
    if (overBudget > 0) lines.push(overBudgetLine(overBudget));
    overBudget = 0;
    return { send: true, text: lines.join('\n\n') };
  };
}
