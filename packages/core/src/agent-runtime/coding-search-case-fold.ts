const MAX_UNIT = 0xffff;

let foldedUnits: { canonical: Int32Array; variants: Map<number, number[]> } | undefined;

const hex = (unit: number) => `\\u${unit.toString(16).padStart(4, '0')}`;

/**
 * ECMAScript Canonicalize without `u`: the single-unit upper case, never non-ASCII to ASCII.
 * The engine's regular-expression case tables may predate the Unicode version `toUpperCase`
 * reads, so every pair is confirmed by the engine once and an unconfirmed unit stays its own.
 */
function folded() {
  if (!foldedUnits) {
    const canonical = new Int32Array(MAX_UNIT + 1);
    const variants = new Map<number, number[]>();
    for (let unit = 0; unit <= MAX_UNIT; unit += 1) {
      const upper = String.fromCharCode(unit).toUpperCase();
      let key =
        upper.length !== 1 || (unit >= 128 && upper.charCodeAt(0) < 128)
          ? unit
          : upper.charCodeAt(0);
      if (key !== unit && !new RegExp(hex(unit), 'i').test(String.fromCharCode(key)))
        key = unit;
      canonical[unit] = key;
      const group = variants.get(key) ?? [];
      group.push(unit);
      variants.set(key, group);
    }
    foldedUnits = { canonical, variants };
  }
  return foldedUnits;
}

/** Units equal to `code` under the `i` flag without `u`; the inverse table is built once. */
export function caseVariants(code: number): number[] {
  const { canonical, variants } = folded();
  return variants.get(canonical[code] ?? code) ?? [code];
}

/** Units with at least one other unit equal to them under `i`; every other unit folds to itself. */
let cased: readonly number[] | undefined;

export function casedUnits(): readonly number[] {
  cased ??= [...folded().variants.values()].filter((group) => group.length > 1).flat();
  return cased;
}
