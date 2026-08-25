import { describe, expect, test } from 'bun:test';
import { parseByteRange, weakETag } from '../src/server/file';

describe('parseByteRange', () => {
  const SIZE = 1000;

  test('no header → null', () => {
    expect(parseByteRange(null, SIZE)).toBeNull();
  });

  test('full range bytes=a-b', () => {
    expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
    expect(parseByteRange('bytes=200-300', SIZE)).toEqual({ start: 200, end: 300 });
  });

  test('single byte bytes=0-0', () => {
    expect(parseByteRange('bytes=0-0', SIZE)).toEqual({ start: 0, end: 0 });
  });

  test('open-ended bytes=a-', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
  });

  test('suffix bytes=-n (last n bytes)', () => {
    expect(parseByteRange('bytes=-300', SIZE)).toEqual({ start: 700, end: 999 });
  });

  test('suffix larger than file → whole file', () => {
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  test('end clamped to size-1', () => {
    expect(parseByteRange('bytes=0-5000', SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  test('whitespace tolerated', () => {
    expect(parseByteRange(' bytes=0-9 ', SIZE)).toEqual({ start: 0, end: 9 });
  });

  test('start >= size → unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=2000-3000', SIZE)).toBe('unsatisfiable');
  });

  test('any range on an empty file → unsatisfiable', () => {
    expect(parseByteRange('bytes=0-10', 0)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-10', 0)).toBe('unsatisfiable');
  });

  test('suffix of zero bytes (bytes=-0) → unsatisfiable', () => {
    expect(parseByteRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });

  test('multiple ranges unsupported → null (serve full)', () => {
    expect(parseByteRange('bytes=0-9,20-29', SIZE)).toBeNull();
  });

  test('malformed → null', () => {
    expect(parseByteRange('bytes=', SIZE)).toBeNull();
    expect(parseByteRange('bytes=-', SIZE)).toBeNull();
    expect(parseByteRange('bytes=abc', SIZE)).toBeNull();
    expect(parseByteRange('bytes=5-3', SIZE)).toBeNull(); // end before start
    expect(parseByteRange('items=0-9', SIZE)).toBeNull(); // wrong unit
    expect(parseByteRange('bytes=1.5-2', SIZE)).toBeNull();
  });
});

describe('weakETag', () => {
  test('deterministic, weak, hex-encoded size + mtime', () => {
    // No self-comparison: a pure one-liner equals itself in every possible
    // implementation. The exact output two lines down is what pins it.
    expect(weakETag(1000, 1_700_000_000_000)).toStartWith('W/"');
    expect(weakETag(10, 16)).toBe('W/"a-10"');
  });

  test('changes with size or mtime', () => {
    expect(weakETag(10, 16)).not.toBe(weakETag(11, 16));
    expect(weakETag(10, 16)).not.toBe(weakETag(10, 17));
  });
});
