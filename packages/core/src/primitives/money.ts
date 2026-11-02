import { z } from 'zod';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { DecimalInputSchema, formatDecimal, parseDecimal } from './decimal';
import { hasWholeSteps, multiplyAndRound, type RoundingPolicy, roundParts } from './rounding';

const IntegerStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)$/);

export interface Money<TCurrency extends string = string> {
  readonly minor: string;
  readonly currency: TCurrency;
}

export function createMoneySchema<const TCurrency extends string>(currency: TCurrency) {
  return z.object({
    minor: IntegerStringSchema,
    currency: z.literal(currency),
  });
}

function parseMinor(value: Money): bigint {
  return BigInt(IntegerStringSchema.parse(value.minor));
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new TypeError(`cannot combine "${left.currency}" and "${right.currency}"`);
  }
}

function money<TCurrency extends string>(
  minor: bigint,
  currency: TCurrency,
): Money<TCurrency> {
  return Object.freeze({ minor: minor.toString(), currency });
}

export function addMoney<TCurrency extends string>(
  left: Money<TCurrency>,
  right: Money<NoInfer<TCurrency>>,
): Money<TCurrency> {
  assertSameCurrency(left, right);
  return money(parseMinor(left) + parseMinor(right), left.currency);
}

export function subtractMoney<TCurrency extends string>(
  left: Money<TCurrency>,
  right: Money<NoInfer<TCurrency>>,
): Money<TCurrency> {
  assertSameCurrency(left, right);
  return money(parseMinor(left) - parseMinor(right), left.currency);
}

export function multiplyMoney<TCurrency extends string>(
  value: Money<TCurrency>,
  quantity: bigint | number,
): Money<TCurrency> {
  if (typeof quantity === 'number' && !Number.isSafeInteger(quantity)) {
    throw new RangeError('quantity must be a safe integer');
  }
  const multiplier = typeof quantity === 'bigint' ? quantity : BigInt(quantity);
  return money(parseMinor(value) * multiplier, value.currency);
}

/** How many decimal places one major unit has: 2 for rubles, 0 for yen, 3 for dinars. */
const ScaleSchema = z.number().int().min(0).max(18);

/**
 * `5041.82` at scale 2 is 504182 minor units. Refuses a value finer than the
 * currency, because dropping those digits here would be a rounding nobody chose:
 * round first, with a policy, if that is what is meant.
 */
export function moneyFromDecimal<const TCurrency extends string>(
  currency: TCurrency,
  value: string,
  scale: number,
): Money<TCurrency> {
  const places = ScaleSchema.parse(scale);
  const parts = parseDecimal(DecimalInputSchema.parse(value));
  if (parts.scale > places) {
    throw new RangeError(`"${value}" is finer than ${places} decimal places`);
  }
  return money(parts.coefficient * 10n ** BigInt(places - parts.scale), currency);
}

/** The amount in major units with every place of the currency: `5041.80`, not `5041.8`. */
export function moneyToDecimal(value: Money, scale: number): string {
  const places = ScaleSchema.parse(scale);
  const minor = parseMinor(value);
  const whole = formatDecimal({ coefficient: minor, scale: places });
  if (places === 0) return whole;
  const [integer = '0', fraction = ''] = whole.split('.');
  return `${integer}.${fraction.padEnd(places, '0')}`;
}

/** Refused by the table rather than by the amount that happens to reach a fractional step. */
function assertMinorSteps(policy: RoundingPolicy): void {
  if (!hasWholeSteps(policy)) {
    throw new RangeError('a money rounding step must be a whole number of minor units');
  }
}

/**
 * Bring an amount to the steps of a policy, whose table is in minor units.
 * `below` and `step` of `{ below: '100000', step: '100' }` mean a price under
 * 1000.00 rounds to whole units of a two-place currency.
 */
export function roundMoney<TCurrency extends string>(
  value: Money<TCurrency>,
  policy: RoundingPolicy,
): Money<TCurrency> {
  assertMinorSteps(policy);
  const rounded = roundParts({ coefficient: parseMinor(value), scale: 0 }, policy);
  return money(rounded.coefficient, value.currency);
}

/**
 * Multiply by a decimal such as a quantity of `2.5` or a rate of `0.2`. The exact
 * product is computed first and rounded once, by the policy the caller names.
 */
export function multiplyMoneyByDecimal<TCurrency extends string>(
  value: Money<TCurrency>,
  factor: string,
  policy: RoundingPolicy,
): Money<TCurrency> {
  assertMinorSteps(policy);
  const rounded = multiplyAndRound(
    { coefficient: parseMinor(value), scale: 0 },
    parseDecimal(DecimalInputSchema.parse(factor)),
    policy,
  );
  return money(rounded.coefficient, value.currency);
}

export interface MoneyShare<TCurrency extends string> {
  readonly amount: Money<TCurrency>;
  readonly remainder: {
    readonly numerator: string;
    readonly denominator: string;
    readonly currency: TCurrency;
  };
}

/** Take an integer rational share and retain the indivisible minor-unit remainder explicitly. */
export function shareMoney<TCurrency extends string>(
  value: Money<TCurrency>,
  numerator: bigint,
  denominator: bigint,
): MoneyShare<TCurrency> {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  if (numerator < 0n) throw new RangeError('numerator must be non-negative');
  const scaled = parseMinor(value) * numerator;
  return Object.freeze({
    amount: money(scaled / denominator, value.currency),
    remainder: Object.freeze({
      numerator: (scaled % denominator).toString(),
      denominator: denominator.toString(),
      currency: value.currency,
    }),
  });
}

export interface MoneySplit<TCurrency extends string> {
  readonly part: Money<TCurrency>;
  readonly count: number;
  readonly remainder: Money<TCurrency>;
}

/** Split into equal whole-minor-unit parts plus the explicit undistributed remainder. */
export function splitMoney<TCurrency extends string>(
  value: Money<TCurrency>,
  count: number,
): MoneySplit<TCurrency> {
  assertPositiveSafeInteger('count', count, RangeError);
  const divisor = BigInt(count);
  const total = parseMinor(value);
  return Object.freeze({
    part: money(total / divisor, value.currency),
    count,
    remainder: money(total % divisor, value.currency),
  });
}

export function defineMoney<const TCurrency extends string>(currency: TCurrency) {
  const schema = createMoneySchema(currency);
  return Object.freeze({
    currency,
    schema,
    create(minor: string | bigint): Money<TCurrency> {
      const parsed = schema.parse({ minor: minor.toString(), currency });
      return Object.freeze(parsed);
    },
    add: addMoney<TCurrency>,
    subtract: subtractMoney<TCurrency>,
    multiply: multiplyMoney<TCurrency>,
    share: shareMoney<TCurrency>,
    split: splitMoney<TCurrency>,
  });
}
