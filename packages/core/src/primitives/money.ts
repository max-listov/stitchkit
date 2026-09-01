import { z } from 'zod';

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
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError('count must be a positive safe integer');
  }
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
