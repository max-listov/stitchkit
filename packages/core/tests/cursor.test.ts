import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../src/contract';

const Cursor = z.object({ v: z.union([z.string(), z.number()]), id: z.string() });

describe('cursor codec', () => {
  test('round-trips a keyset value', () => {
    const value = { v: '2026-06-05T00:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(value), Cursor)).toEqual(value);
  });

  test('round-trips a numeric sort value', () => {
    const value = { v: 1717545600000, id: 'x' };
    expect(decodeCursor(encodeCursor(value), Cursor)).toEqual(value);
  });

  test('output is URL-safe (no +, /, = padding)', () => {
    const encoded = encodeCursor({ v: 'a'.repeat(20), id: 'b'.repeat(20) });
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test('UTF-8 sort value round-trips (naïve btoa would corrupt it)', () => {
    const value = { v: 'Привет 🚀 café', id: 'u1' };
    expect(decodeCursor(encodeCursor(value), Cursor)).toEqual(value);
  });

  test('missing cursor → null', () => {
    expect(decodeCursor(null, Cursor)).toBeNull();
    expect(decodeCursor(undefined, Cursor)).toBeNull();
    expect(decodeCursor('', Cursor)).toBeNull();
  });

  test('garbage / non-base64 / non-JSON → null (treated as no cursor)', () => {
    expect(decodeCursor('!!!not base64!!!', Cursor)).toBeNull();
    expect(decodeCursor(encodeCursor('not an object'), Cursor)).toBeNull();
  });

  test('schema-invalid shape → null', () => {
    // valid base64/JSON, but wrong shape for the cursor schema
    expect(decodeCursor(encodeCursor({ id: 5 }), Cursor)).toBeNull();
  });
});
