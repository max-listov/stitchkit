const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseDecimal(value: string): DecimalParts {
  if (!DECIMAL_PATTERN.test(value)) throw new TypeError(`invalid decimal value "${value}"`);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${negative ? '-' : ''}${whole}${fraction}`);
  return normalizeDecimal({ coefficient, scale: fraction.length });
}

export function normalizeDecimal(parts: DecimalParts): DecimalParts {
  let coefficient = parts.coefficient;
  let scale = parts.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

export function formatDecimal(parts: DecimalParts): string {
  const normalized = normalizeDecimal(parts);
  const negative = normalized.coefficient < 0n;
  const digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(normalized.scale + 1, '0');
  const point = padded.length - normalized.scale;
  return `${negative ? '-' : ''}${padded.slice(0, point)}.${padded.slice(point)}`;
}

export function addDecimal(left: DecimalParts, right: DecimalParts): DecimalParts {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return normalizeDecimal({ coefficient: leftCoefficient + rightCoefficient, scale });
}

export function multiplyDecimalRatio(
  value: DecimalParts,
  numerator: bigint,
  denominator: bigint,
): DecimalParts {
  if (denominator <= 0n) throw new RangeError('conversion denominator must be positive');
  let coefficient = value.coefficient * numerator;
  let scale = value.scale;
  for (let extraScale = 0; extraScale <= 18; extraScale += 1) {
    if (coefficient % denominator === 0n) {
      return normalizeDecimal({ coefficient: coefficient / denominator, scale });
    }
    coefficient *= 10n;
    scale += 1;
  }
  throw new RangeError('conversion does not have a finite decimal representation');
}
