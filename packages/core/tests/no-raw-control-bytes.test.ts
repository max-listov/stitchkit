/**
 * Regression guard: no `.ts` source file may contain a **raw** control byte.
 *
 * A regex/string written with literal control bytes (NUL, US, DEL, …) instead of
 * `\u`/`\x` escapes is invisible in editors, makes the file "binary" to grep, and
 * — the reason this test exists — gets copied verbatim into the bundle, where
 * some Bun regex-parser versions reject a raw-byte character class at module
 * load, crashing every `import` of the package. It shipped once (a `safePath`
 * regex) and was invisible in review. This scan catches a re-introduction.
 *
 * Allowed whitespace controls: TAB (0x09), LF (0x0a), CR (0x0d).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

function hasRawControlByte(bytes: Buffer): boolean {
  for (const b of bytes) {
    if (b <= 0x08 || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f) || b === 0x7f) {
      return true;
    }
  }
  return false;
}

describe('source hygiene', () => {
  test('no raw control bytes in any src/*.ts (use \\u / \\x escapes)', () => {
    const glob = new Glob('**/*.ts');
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of glob.scanSync({ cwd: `${import.meta.dir}/../src`, absolute: true })) {
      scanned += 1;
      if (hasRawControlByte(readFileSync(file))) offenders.push(file);
    }
    // The denominator, asserted before the numerator. A glob whose cwd stopped
    // resolving — `src/` moved, the package re-laid-out — yields nothing and
    // this test would report an empty offender list, which reads exactly like a
    // clean scan. The floor is a floor, not a target: 270 files today, and it
    // exists to separate "looked and found nothing" from "did not look".
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
