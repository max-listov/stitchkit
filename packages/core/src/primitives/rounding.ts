import { z } from 'zod';
import {
  DecimalInputSchema,
  type DecimalParts,
  DecimalStringSchema,
  formatDecimal,
  parseDecimal,
} from './decimal';

/**
 * How a value between two steps lands. `half-up` takes a tie away from zero and
 * `half-even` to the even step, `up` always leaves zero and `down` always nears it.
 */
export const RoundingModeSchema = z.enum(['half-up', 'half-even', 'up', 'down']);
export type RoundingMode = z.infer<typeof RoundingModeSchema>;

function isPositive(value: string): boolean {
  return DecimalStringSchema.safeParse(value).success && parseDecimal(value).coefficient > 0n;
}

function compareParts(left: DecimalParts, right: DecimalParts): number {
  const scale = BigInt(Math.max(left.scale, right.scale));
  const a = left.coefficient * 10n ** (scale - BigInt(left.scale));
  const b = right.coefficient * 10n ** (scale - BigInt(right.scale));
  return a < b ? -1 : a > b ? 1 : 0;
}

const RoundingTierSchema = z.object({
  /** The tier covers magnitudes under this. The last tier omits it and covers the rest. */
  below: z.string().refine(isPositive, 'expected a positive decimal').optional(),
  step: z.string().refine(isPositive, 'expected a positive decimal'),
});

/**
 * A rounding table: the first tier whose `below` exceeds the magnitude gives the
 * step. Data rather than a callback, so it can be stored with the prices it
 * produced and read back when one of them is questioned.
 */
export const RoundingPolicySchema = z
  .object({ mode: RoundingModeSchema, tiers: z.array(RoundingTierSchema).min(1) })
  .superRefine(({ tiers }, context) => {
    const bounds = tiers.map((tier) => tier.below);
    if (bounds.at(-1) !== undefined || bounds.slice(0, -1).includes(undefined)) {
      context.addIssue({ code: 'custom', message: 'only the last tier omits "below"' });
    }
    const ordered = bounds.flatMap((bound) =>
      bound !== undefined && isPositive(bound) ? [parseDecimal(bound)] : [],
    );
    for (const [index, bound] of ordered.entries()) {
      const next = ordered[index + 1];
      if (next !== undefined && compareParts(bound, next) >= 0) {
        context.addIssue({ code: 'custom', message: '"below" must ascend' });
      }
    }
  });
export type RoundingPolicy = z.infer<typeof RoundingPolicySchema>;

export function defineRoundingPolicy(
  policy: z.input<typeof RoundingPolicySchema>,
): RoundingPolicy {
  const { mode, tiers } = RoundingPolicySchema.parse(policy);
  return Object.freeze({ mode, tiers: tiers.map((tier) => Object.freeze(tier)) });
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** `numerator / denominator` as an integer, by `mode`; the denominator is positive. */
function roundRatio(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const magnitude = absolute(numerator);
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const twice = remainder * 2n;
  const away =
    remainder !== 0n &&
    (mode === 'up' ||
      (mode === 'half-up' && twice >= denominator) ||
      (mode === 'half-even' &&
        (twice > denominator || (twice === denominator && quotient % 2n === 1n))));
  const rounded = away ? quotient + 1n : quotient;
  return numerator < 0n ? -rounded : rounded;
}

function stepFor(value: DecimalParts, policy: RoundingPolicy): DecimalParts {
  const magnitude = { ...value, coefficient: absolute(value.coefficient) };
  const tier = policy.tiers.find(
    ({ below }) => below === undefined || compareParts(magnitude, parseDecimal(below)) < 0,
  );
  if (tier === undefined) throw new TypeError('a rounding policy needs a last tier');
  return parseDecimal(tier.step);
}

/** Whether every result of the table is a whole number, whatever the value. */
export function hasWholeSteps(policy: RoundingPolicy): boolean {
  return policy.tiers.every(({ step }) => parseDecimal(step).scale === 0);
}

export function roundParts(value: DecimalParts, policy: RoundingPolicy): DecimalParts {
  const step = stepFor(value, policy);
  const steps = roundRatio(
    value.coefficient * 10n ** BigInt(step.scale),
    step.coefficient * 10n ** BigInt(value.scale),
    policy.mode,
  );
  return { coefficient: steps * step.coefficient, scale: step.scale };
}

/** The exact product, rounded once. */
export function multiplyAndRound(
  left: DecimalParts,
  right: DecimalParts,
  policy: RoundingPolicy,
): DecimalParts {
  return roundParts(
    { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale },
    policy,
  );
}

/** A decimal string brought to the table's step, in canonical spelling. */
export function roundDecimal(value: string, policy: RoundingPolicy): string {
  return formatDecimal(roundParts(parseDecimal(DecimalInputSchema.parse(value)), policy));
}
