import {
  type SpendCostStatus,
  type SpendFacts,
  type SpendReceipt,
  SpendReceiptSchema,
} from './schemas';

/** A cost that counts as a fact. `estimated` never does, and `pending`/`unknown` have no number. */
const isFactual = (status: SpendCostStatus) => status === 'reported' || status === 'free';

type CostFields = Pick<SpendFacts, 'costStatus' | 'costUsd'>;

function costOf(facts: SpendFacts): CostFields {
  return {
    costStatus: facts.costStatus,
    ...(facts.costUsd !== undefined &&
      facts.costStatus !== 'pending' &&
      facts.costStatus !== 'unknown' && { costUsd: facts.costUsd }),
  };
}

/** A factual cost is never replaced by a non-factual one; otherwise the newer observer decides. */
function mergedCost(older: SpendFacts, newer: SpendFacts): CostFields {
  if (isFactual(older.costStatus) && !isFactual(newer.costStatus)) return costOf(older);
  return costOf(newer);
}

/**
 * Fold a receipt into what is known of its attempt. Monotone, so replays and
 * out-of-order delivery converge: a field the higher-ranked receipt knows wins, a
 * field it does not know keeps the other's value, a closed outcome never returns
 * to `pending`, and a provider-reported cost is never erased by a later guess.
 * Equal ranks: the receipt with the later `at` wins, whatever order they arrive in.
 * An `orphaned` close (a sweep found nothing) never replaces a real one. Fields are
 * ranked by receipt, not each: it assumes one transport-side receipt per attempt
 * (the gateway writes exactly one), followed by reconciler receipts.
 */
export function mergeSpendReceipt(
  previous: SpendReceipt | undefined,
  next: SpendReceipt,
): SpendReceipt {
  const incoming = SpendReceiptSchema.parse(next);
  if (previous === undefined) return incoming;
  const known = SpendReceiptSchema.parse(previous);
  if (known.attemptId !== incoming.attemptId)
    throw new TypeError('A spend receipt merges only with its own attempt');
  // An orphan says only that nothing came back: it never replaces a close, and
  // whatever does come back replaces it whole.
  if (incoming.outcome === 'orphaned') return known;
  if (known.outcome === 'orphaned') return incoming;
  const newerWins =
    incoming.rank > known.rank ||
    (incoming.rank === known.rank && Date.parse(incoming.at) >= Date.parse(known.at));
  const [older, newer] = newerWins ? [known, incoming] : [incoming, known];
  const defined: Partial<SpendFacts> = Object.fromEntries(
    Object.entries(newer.facts).filter(([, value]) => value !== undefined),
  );
  const facts: SpendFacts = { ...older.facts, ...defined };
  const outcome =
    newer.outcome === 'pending' && older.outcome !== 'pending' ? older.outcome : newer.outcome;
  const cost = mergedCost(older.facts, newer.facts);
  const { costUsd: _dropped, ...withoutCost } = facts;
  return SpendReceiptSchema.parse({
    attemptId: known.attemptId,
    rank: newerWins ? incoming.rank : known.rank,
    at: newer.at,
    outcome,
    facts: { ...withoutCost, ...cost },
  });
}
