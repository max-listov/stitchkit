import { describe, expect, test } from 'bun:test';
import { applyWatchDelta, watchDeltaWins, watchDiff } from '../src/entrypoints/live';

function window() {
  return Array.from({ length: 100 }, (_, i) => ({
    id: `entry-${i}`,
    payload: String(i).repeat(400),
  }));
}

describe('array delta preserves the reusable window', () => {
  test('prepend with tail eviction sends less than five percent of the full value', () => {
    const before = window();
    const head = { id: 'new', payload: 'new'.repeat(400) };
    const after = [head, ...before.slice(0, -1)];
    const delta = watchDiff(before, after);
    if (!delta) throw new Error('expected a delta');
    expect(applyWatchDelta(before, delta)).toEqual(after);
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(after).length * 0.05);
    expect(delta).toEqual({
      t: 'arr',
      ops: [
        { o: 'put', v: head },
        { o: 'copy', from: 0, count: 99 },
      ],
    });
  });

  test('append with head eviction and reorder preserve exact values cheaply', () => {
    const before = window();
    for (const after of [
      [...before.slice(1), { id: 'new', payload: 'new'.repeat(400) }],
      [...before.slice(50), ...before.slice(0, 50)],
      [...before].reverse(),
    ]) {
      const delta = watchDiff(before, after);
      if (!delta) throw new Error('expected a delta');
      expect(applyWatchDelta(before, delta)).toEqual(after);
      expect(watchDeltaWins(delta, after)).toBe(true);
    }
  });

  test('a changed head is patched while unchanged elements move', () => {
    const before = window();
    const head = { id: 'entry-0', payload: '0'.repeat(400), seen: true };
    const after = [head, ...before.slice(50), ...before.slice(1, 50)];
    const delta = watchDiff(before, after);
    if (!delta) throw new Error('expected a delta');
    expect(applyWatchDelta(before, delta)).toEqual(after);
    expect(JSON.stringify(delta).length).toBeLessThan(300);
    expect(delta).toEqual({
      t: 'arr',
      ops: [
        { o: 'patch', from: 0, d: { t: 'obj', set: { seen: { t: 'set', v: true } } } },
        { o: 'copy', from: 50, count: 50 },
        { o: 'copy', from: 1, count: 49 },
      ],
    });
  });

  test('duplicate runs survive insertion, exhaustion and changed multiplicity', () => {
    const a = { key: 'a', payload: 'a'.repeat(400) };
    const b = { key: 'b', payload: 'b'.repeat(400) };
    const before = [a, a, b, b, a];
    for (const after of [
      [b, a, a, b, a, a],
      [null, a, a, b, b],
      [a, b, a],
    ]) {
      const delta = watchDiff(before, after);
      if (!delta) throw new Error('expected a delta');
      expect(applyWatchDelta(before, delta)).toEqual(after);
      expect(watchDeltaWins(delta, after)).toBe(true);
    }
  });

  test('large interleaved duplicate buckets reconstruct exactly', () => {
    const before = Array.from({ length: 30_000 }, (_, i) => i % 2);
    const after = [...before.filter((n) => n === 0), ...before.filter((n) => n === 1)];
    const delta = watchDiff(before, after);
    if (!delta) throw new Error('expected a delta');
    expect(applyWatchDelta(before, delta)).toEqual(after);
  });

  test('successive seeded edits preserve arrays with duplicate nested values', () => {
    let seed = 20260927;
    const pick = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    let before = Array.from({ length: 80 }, () => ({
      id: pick(6),
      nested: { values: [pick(3), pick(3)] },
    }));
    for (let round = 0; round < 1000; round += 1) {
      const after = [...before];
      const index = pick(after.length + 1);
      after.splice(index, pick(3), { id: pick(6), nested: { values: [pick(3), pick(3)] } });
      const shift = pick(after.length + 1);
      after.push(...after.splice(0, shift));
      if (pick(2)) after.reverse();
      const delta = watchDiff(before, after);
      expect(delta === undefined ? before : applyWatchDelta(before, delta)).toEqual(after);
      before = after;
    }
  });

  test('a wholly new collection retains the full-value fallback', () => {
    const before = window();
    const after = before.map((_, i) => ({ other: i }));
    const delta = watchDiff(before, after);
    if (!delta) throw new Error('expected a delta');
    expect(applyWatchDelta(before, delta)).toEqual(after);
    expect(watchDeltaWins(delta, after)).toBe(false);
  });
});
