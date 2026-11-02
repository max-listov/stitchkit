import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createQuantitySchema,
  DecimalInputSchema,
  DecimalStringSchema,
  defineMoney,
  defineRoundingPolicy,
  moneyFromDecimal,
  moneyToDecimal,
  multiplyMoneyByDecimal,
  RoundingPolicySchema,
  roundDecimal,
  roundMoney,
} from '../src/entrypoints/primitives';

const kopeck = defineRoundingPolicy({ mode: 'half-up', tiers: [{ step: '1' }] });
const banker = defineRoundingPolicy({ mode: 'half-even', tiers: [{ step: '1' }] });
const shelf = defineRoundingPolicy({
  mode: 'half-up',
  tiers: [{ below: '100', step: '0.01' }, { below: '1000', step: '1' }, { step: '10' }],
});

describe('decimal strings', () => {
  test('a float does not pass, whatever it adds up to', () => {
    expect(DecimalStringSchema.safeParse(0.1 + 0.2).success).toBe(false);
    expect(DecimalInputSchema.safeParse(0.1 + 0.2).success).toBe(false);
    expect(DecimalStringSchema.safeParse('0.3').success).toBe(true);
  });

  test.each(['10.50', '+1', '.5', '1e3', '', ' 1', '01', 'NaN'])(
    'the canonical schema refuses %j',
    (value) => {
      expect(DecimalStringSchema.safeParse(value).success).toBe(false);
    },
  );

  test('the input schema brings a database spelling to the canonical one', () => {
    expect(DecimalInputSchema.parse('10.50')).toBe('10.5');
    expect(DecimalInputSchema.parse('-0.00')).toBe('0');
    expect(DecimalInputSchema.safeParse('1e3').success).toBe(false);
  });

  test('a quantity shares that schema', () => {
    const grams = createQuantitySchema('g');
    expect(grams.safeParse({ value: '2.5', unit: 'g' }).success).toBe(true);
    expect(grams.safeParse({ value: 2.5, unit: 'g' }).success).toBe(false);
  });
});

describe('rounding', () => {
  test.each([
    ['half-up', '2.5', '3'],
    ['half-up', '-2.5', '-3'],
    ['half-even', '2.5', '2'],
    ['half-even', '3.5', '4'],
    ['half-even', '2.6', '3'],
    ['up', '2.1', '3'],
    ['up', '-2.1', '-3'],
    ['down', '2.9', '2'],
    ['down', '-2.9', '-2'],
    ['up', '2', '2'],
  ] as const)('%s takes %s to %s', (mode, value, expected) => {
    expect(roundDecimal(value, defineRoundingPolicy({ mode, tiers: [{ step: '1' }] }))).toBe(
      expected,
    );
  });

  test.each([
    ['99.994', '99.99'],
    ['99.999', '100'],
    ['100.4', '100'],
    ['999.5', '1000'],
    ['5041.82', '5040'],
    ['5045', '5050'],
    ['-5045', '-5050'],
  ])('the table takes %s to %s', (value, expected) => {
    expect(roundDecimal(value, shelf)).toBe(expected);
  });

  test('a step need not be a power of ten', () => {
    const coins = defineRoundingPolicy({ mode: 'half-up', tiers: [{ step: '0.05' }] });
    expect(roundDecimal('1.02', coins)).toBe('1');
    expect(roundDecimal('1.03', coins)).toBe('1.05');
  });

  test.each([
    [{ mode: 'half-up', tiers: [] }],
    [{ mode: 'half-up', tiers: [{ below: '10', step: '1' }] }],
    [{ mode: 'half-up', tiers: [{ step: '1' }, { step: '2' }] }],
    [{ mode: 'half-up', tiers: [{ step: '0' }] }],
    [{ mode: 'half-up', tiers: [{ step: '-1' }] }],
    [{ mode: 'half-up', tiers: [{ step: 0.01 }] }],
    [
      {
        mode: 'half-up',
        tiers: [{ below: '10', step: '1' }, { below: '5', step: '1' }, { step: '1' }],
      },
    ],
    [{ mode: 'nearest', tiers: [{ step: '1' }] }],
    [{ mode: 'half-up', tiers: [{ step: 'abc' }] }],
    [{ mode: 'half-up', tiers: [{ below: '01', step: '1' }, { step: '1' }] }],
  ])('a policy that cannot mean anything is refused: %j', (policy) => {
    expect(RoundingPolicySchema.safeParse(policy).success).toBe(false);
  });
});

describe('money across decimals', () => {
  test('major units keep every place of the currency', () => {
    const price = moneyFromDecimal('RUB', '5041.82', 2);
    expect(price).toEqual({ minor: '504182', currency: 'RUB' });
    expect(moneyToDecimal(price, 2)).toBe('5041.82');
    expect(moneyToDecimal(moneyFromDecimal('RUB', '5041.8', 2), 2)).toBe('5041.80');
    expect(moneyToDecimal(moneyFromDecimal('RUB', '-0.05', 2), 2)).toBe('-0.05');
    expect(moneyToDecimal(moneyFromDecimal('JPY', '5041', 0), 0)).toBe('5041');
    expect(moneyToDecimal(moneyFromDecimal('BHD', '1.5', 3), 3)).toBe('1.500');
  });

  test('a value finer than the currency is refused rather than cut', () => {
    expect(() => moneyFromDecimal('RUB', '5041.825', 2)).toThrow(RangeError);
    expect(() => moneyFromDecimal('JPY', '1.5', 0)).toThrow(RangeError);
    expect(() => moneyFromDecimal('RUB', '5041.82', 2.5)).toThrow();
  });

  test('a product is exact before its one rounding, where float arithmetic is not', () => {
    const price = moneyFromDecimal('RUB', '5041.82', 2);
    // Float: 5041.82 * 1.1 === 5546.0020000000004
    expect(multiplyMoneyByDecimal(price, '1.1', kopeck).minor).toBe('554600');
    // Float: 1.005 * 100 === 100.49999999999999, and the half is lost.
    const tie = moneyFromDecimal('RUB', '1', 2);
    expect(multiplyMoneyByDecimal(tie, '1.005', kopeck).minor).toBe('101');
    expect(multiplyMoneyByDecimal(tie, '1.005', banker).minor).toBe('100');
    expect(multiplyMoneyByDecimal(tie, '-1.005', kopeck).minor).toBe('-101');
  });

  test('a quantity from the unit system prices a line', () => {
    const rub = defineMoney('RUB');
    const unit = rub.create('19999');
    expect(multiplyMoneyByDecimal(unit, '2.5', kopeck)).toEqual({
      minor: '49998',
      currency: 'RUB',
    });
  });

  test('the table of a price reads in minor units', () => {
    const toRubles = defineRoundingPolicy({
      mode: 'half-up',
      tiers: [{ below: '100000', step: '100' }, { step: '1000' }],
    });
    const price = moneyFromDecimal('RUB', '5041.82', 2);
    expect(moneyToDecimal(roundMoney(price, toRubles), 2)).toBe('5040.00');
  });

  test('a fractional minor unit is refused rather than stored', () => {
    const half = defineRoundingPolicy({ mode: 'half-up', tiers: [{ step: '0.5' }] });
    const price = moneyFromDecimal('RUB', '1', 2);
    expect(() => multiplyMoneyByDecimal(price, '1.003', half)).toThrow(
      'whole number of minor units',
    );
    expect(() => roundMoney(price, half)).toThrow('whole number of minor units');
  });

  test('every new entry refuses a number at run time', () => {
    const price = moneyFromDecimal('RUB', '1', 2);
    const float: unknown = 0.1 + 0.2;
    const asString = (value: unknown): string => value as string;
    expect(() => moneyFromDecimal('RUB', asString(float), 2)).toThrow();
    expect(() => multiplyMoneyByDecimal(price, asString(float), kopeck)).toThrow();
    expect(() => roundDecimal(asString(float), kopeck)).toThrow();
  });

  test('no float arithmetic lives in these modules', async () => {
    for (const name of ['rounding.ts', 'decimal.ts']) {
      const source = await readFile(join(import.meta.dir, '../src/primitives', name), 'utf8');
      expect(source).not.toMatch(/parseFloat|toFixed|Math\.round|Number\(/);
    }
  });
});
