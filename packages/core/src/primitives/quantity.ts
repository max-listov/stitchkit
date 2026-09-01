import { z } from 'zod';
import { addDecimal, formatDecimal, multiplyDecimalRatio, parseDecimal } from './decimal';

const DecimalStringSchema = z.string().refine((value) => {
  try {
    return formatDecimal(parseDecimal(value)) === value;
  } catch {
    return false;
  }
}, 'expected a canonical decimal string');

export interface Quantity<TUnit extends string = string> {
  readonly value: string;
  readonly unit: TUnit;
}

export function createQuantitySchema<const TUnit extends string>(unit: TUnit) {
  return z.object({ value: DecimalStringSchema, unit: z.literal(unit) });
}

function quantity<TUnit extends string>(value: string, unit: TUnit): Quantity<TUnit> {
  return Object.freeze({ value: formatDecimal(parseDecimal(value)), unit });
}

function sameUnit(left: string, right: string): boolean {
  return left === right;
}

export function addQuantity<TUnit extends string>(
  left: Quantity<TUnit>,
  right: Quantity<NoInfer<TUnit>>,
): Quantity<TUnit> {
  if (!sameUnit(left.unit, right.unit)) {
    throw new TypeError(`cannot combine "${left.unit}" and "${right.unit}"`);
  }
  return quantity(
    formatDecimal(addDecimal(parseDecimal(left.value), parseDecimal(right.value))),
    left.unit,
  );
}

export interface UnitConversion<TUnit extends string = string> {
  readonly id: string;
  readonly from: TUnit;
  readonly to: TUnit;
  readonly numerator: string;
  readonly denominator: string;
}

export type QuantityProjection<TUnit extends string = string> =
  | { readonly kind: 'recorded'; readonly quantity: Quantity<TUnit> }
  | {
      readonly kind: 'derived';
      readonly quantity: Quantity<TUnit>;
      readonly source: Quantity;
      readonly conversionId: string;
    };

export const QuantityProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recorded'),
    quantity: z.object({ value: DecimalStringSchema, unit: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('derived'),
    quantity: z.object({ value: DecimalStringSchema, unit: z.string().min(1) }),
    source: z.object({ value: DecimalStringSchema, unit: z.string().min(1) }),
    conversionId: z.string().min(1),
  }),
]);

export function defineUnitSystem<const TUnit extends string>(config: {
  readonly units: readonly TUnit[];
  readonly conversions: readonly UnitConversion<TUnit>[];
}) {
  const ids = new Set<string>();
  for (const conversion of config.conversions) {
    if (ids.has(conversion.id)) {
      throw new Error(`[stitchkit] duplicate conversion id "${conversion.id}"`);
    }
    ids.add(conversion.id);
    if (!/^-?(?:0|[1-9]\d*)$/.test(conversion.numerator)) {
      throw new Error(
        `[stitchkit] conversion "${conversion.id}" numerator must be an integer`,
      );
    }
    if (!/^(?:[1-9]\d*)$/.test(conversion.denominator)) {
      throw new Error(
        `[stitchkit] conversion "${conversion.id}" denominator must be positive`,
      );
    }
  }
  return Object.freeze({
    definition: config,
    create<TSelected extends TUnit>(value: string, unit: TSelected): Quantity<TSelected> {
      if (!config.units.includes(unit)) throw new Error(`[stitchkit] unknown unit "${unit}"`);
      return quantity(value, unit);
    },
    recorded<TSelected extends TUnit>(
      value: Quantity<TSelected>,
    ): QuantityProjection<TSelected> {
      return Object.freeze({ kind: 'recorded', quantity: value });
    },
    convert<TFrom extends TUnit, TTo extends TUnit>(
      source: Quantity<TFrom>,
      to: TTo,
    ): QuantityProjection<TTo> {
      if (sameUnit(source.unit, to)) {
        return Object.freeze({
          kind: 'derived',
          quantity: quantity(source.value, to),
          source,
          conversionId: 'identity',
        });
      }
      const conversion = config.conversions.find(
        (candidate) => candidate.from === source.unit && candidate.to === to,
      );
      if (!conversion) {
        throw new Error(`[stitchkit] no conversion from "${source.unit}" to "${to}"`);
      }
      const converted = multiplyDecimalRatio(
        parseDecimal(source.value),
        BigInt(conversion.numerator),
        BigInt(conversion.denominator),
      );
      return Object.freeze({
        kind: 'derived',
        quantity: quantity(formatDecimal(converted), to),
        source,
        conversionId: conversion.id,
      });
    },
  });
}
