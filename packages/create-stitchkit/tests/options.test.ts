import { describe, expect, test } from 'bun:test';
import { parseOptions } from '../src/options';

describe('create-stitchkit options', () => {
  test('parses a destination and install preference', () => {
    expect(parseOptions(['my-app'])).toEqual({ destination: 'my-app', install: true });
    expect(parseOptions(['my-app', '--no-install'])).toEqual({
      destination: 'my-app',
      install: false,
    });
  });

  test('rejects missing and extra destinations', () => {
    expect(() => parseOptions([])).toThrow('Exactly one destination');
    expect(() => parseOptions(['one', 'two'])).toThrow('Exactly one destination');
  });

  test('rejects unknown options', () => {
    expect(() => parseOptions(['app', '--package-manager=npm'])).toThrow('Unknown option');
  });
});
