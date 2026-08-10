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

  test('parses the isolated repository example', () => {
    expect(parseOptions(['my-app', '--example', 'repository'])).toEqual({
      destination: 'my-app',
      install: true,
      example: 'repository',
    });
  });

  test('parses a custom display name', () => {
    expect(parseOptions(['talk-control', '--display-name', 'Talk Control'])).toEqual({
      destination: 'talk-control',
      install: true,
      displayName: 'Talk Control',
    });
  });

  test('rejects missing and extra destinations', () => {
    expect(() => parseOptions([])).toThrow('Exactly one destination');
    expect(() => parseOptions(['one', 'two'])).toThrow('Exactly one destination');
  });

  test('rejects unknown options', () => {
    expect(() => parseOptions(['app', '--package-manager=npm'])).toThrow('Unknown option');
  });

  test('rejects missing and unknown examples', () => {
    expect(() => parseOptions(['app', '--example'])).toThrow('--example requires a value');
    expect(() => parseOptions(['app', '--example', 'notes'])).toThrow('Unknown example');
  });

  test('rejects a missing display name', () => {
    expect(() => parseOptions(['app', '--display-name'])).toThrow(
      '--display-name requires a value',
    );
  });
});
