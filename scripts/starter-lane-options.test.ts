import { describe, expect, test } from 'bun:test';
import { parseStarterLaneOptions } from './starter-lane-options';

describe('starter lane options', () => {
  test('parses every explicit mode and variant combination', () => {
    expect(parseStarterLaneOptions(['--mode=target', '--variant=blank'])).toEqual({
      mode: 'target',
      variant: 'blank',
    });
    expect(parseStarterLaneOptions(['--variant=repository', '--mode=head'])).toEqual({
      mode: 'head',
      variant: 'repository',
    });
  });

  test('fails first on missing, duplicate, empty and unknown arguments', () => {
    expect(() => parseStarterLaneOptions(['--mode=target'])).toThrow(
      'Expected exactly one --variant=<value> argument',
    );
    expect(() =>
      parseStarterLaneOptions(['--mode=target', '--mode=head', '--variant=blank']),
    ).toThrow('Expected exactly one --mode=<value> argument');
    expect(() => parseStarterLaneOptions(['--mode=', '--variant=blank'])).toThrow(
      '--mode=<value> cannot be empty',
    );
    expect(() => parseStarterLaneOptions(['--mode=other', '--variant=blank'])).toThrow(
      'Unknown starter lane mode: other',
    );
    expect(() => parseStarterLaneOptions(['--mode=head', '--variant=other'])).toThrow(
      'Unknown starter lane variant: other',
    );
    expect(() =>
      parseStarterLaneOptions(['--mode=head', '--variant=blank', '--head']),
    ).toThrow('Unknown starter lane arguments: --head');
  });
});
