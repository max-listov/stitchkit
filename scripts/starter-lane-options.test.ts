import { describe, expect, test } from 'bun:test';
import { parseStarterLaneOptions } from './starter-lane-options';

describe('starter lane options', () => {
  test('parses explicit mode, variant and browser combinations', () => {
    expect(
      parseStarterLaneOptions(['--mode=target', '--variant=blank', '--browser=chromium']),
    ).toEqual({
      mode: 'target',
      variant: 'blank',
      browser: 'chromium',
    });
    expect(
      parseStarterLaneOptions(['--browser=all', '--variant=repository', '--mode=head']),
    ).toEqual({
      mode: 'head',
      variant: 'repository',
      browser: 'all',
    });
  });

  test('fails first on missing, duplicate, empty and unknown arguments', () => {
    expect(() => parseStarterLaneOptions(['--mode=target', '--browser=all'])).toThrow(
      'Expected exactly one --variant=<value> argument',
    );
    expect(() =>
      parseStarterLaneOptions([
        '--mode=target',
        '--mode=head',
        '--variant=blank',
        '--browser=all',
      ]),
    ).toThrow('Expected exactly one --mode=<value> argument');
    expect(() =>
      parseStarterLaneOptions(['--mode=', '--variant=blank', '--browser=all']),
    ).toThrow('--mode=<value> cannot be empty');
    expect(() =>
      parseStarterLaneOptions(['--mode=other', '--variant=blank', '--browser=all']),
    ).toThrow('Unknown starter lane mode: other');
    expect(() =>
      parseStarterLaneOptions(['--mode=head', '--variant=other', '--browser=all']),
    ).toThrow('Unknown starter lane variant: other');
    expect(() =>
      parseStarterLaneOptions(['--mode=head', '--variant=blank', '--browser=other']),
    ).toThrow('Unknown starter lane browser: other');
    expect(() =>
      parseStarterLaneOptions(['--mode=head', '--variant=blank', '--browser=all', '--head']),
    ).toThrow('Unknown starter lane arguments: --head');
  });
});
