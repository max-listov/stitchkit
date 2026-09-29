import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { extractCliGlobalOptions, parseCliArgs } from '../src/tools/cli/args';
import { routeCliArgv } from '../src/tools/cli/args-route';

/*
 * `--flag true` and `--flag false` are an ordinary habit. Read as "the flag,
 * plus a positional", the word slid into the first non-boolean field — and
 * `--flag false` turned the flag ON. After a bare boolean flag, the next token
 * is its value when it is exactly `true` or `false`; anything else stays a
 * positional, as before.
 */

const schema = z.object({
  botId: z.string().optional(),
  visibility: z.enum(['A', 'B']).optional(),
  includeEmbedded: z.boolean().optional(),
});

describe('a boolean flag followed by true or false', () => {
  test('the word is the flag value, and positionals do not shift', () => {
    expect(parseCliArgs(['bot1', '--includeEmbedded', 'true'], schema).toolArgs).toEqual({
      botId: 'bot1',
      includeEmbedded: true,
    });
    expect(parseCliArgs(['bot1', '--includeEmbedded', 'false'], schema).toolArgs).toEqual({
      botId: 'bot1',
      includeEmbedded: false,
    });
    expect(parseCliArgs(['--includeEmbedded', 'false', 'bot1', 'A'], schema).toolArgs).toEqual(
      {
        botId: 'bot1',
        visibility: 'A',
        includeEmbedded: false,
      },
    );
  });

  test('the bare, inline and negated forms mean what they meant', () => {
    expect(parseCliArgs(['--includeEmbedded'], schema).toolArgs).toEqual({
      includeEmbedded: true,
    });
    expect(parseCliArgs(['--includeEmbedded=false'], schema).toolArgs).toEqual({
      includeEmbedded: false,
    });
    expect(parseCliArgs(['--no-includeEmbedded'], schema).toolArgs).toEqual({
      includeEmbedded: false,
    });
  });

  test('any other word after the flag stays a positional, as before', () => {
    expect(parseCliArgs(['--includeEmbedded', 'bot1'], schema).toolArgs).toEqual({
      botId: 'bot1',
      includeEmbedded: true,
    });
    // `1`, `yes` and `no` are values of other fields as often as not; they are not taken.
    expect(parseCliArgs(['--includeEmbedded', 'no'], schema).toolArgs).toEqual({
      botId: 'no',
      includeEmbedded: true,
    });
    // `--` still makes a literal `false` a positional.
    expect(parseCliArgs(['--includeEmbedded', '--', 'false'], schema).toolArgs).toEqual({
      botId: 'false',
      includeEmbedded: true,
    });
  });

  test('the same for a short alias, a framework flag and an application option', () => {
    const aliases = new Map([['e', 'includeEmbedded']]);
    expect(
      parseCliArgs(['-e', 'false', 'bot1'], schema, { optionAliases: aliases }).toolArgs,
    ).toEqual({ botId: 'bot1', includeEmbedded: false });
    const parsed = parseCliArgs(['--json', 'false', '--dry-run', 'true', 'bot1'], schema);
    expect(parsed.options).toMatchObject({ json: false, dryRun: true });
    expect(parsed.toolArgs).toEqual({ botId: 'bot1' });
    const globals = extractCliGlobalOptions(
      ['--verbose', 'false', 'list'],
      z.object({ verbose: z.boolean().optional() }),
    );
    expect(globals).toEqual({ argv: ['list'], globals: { verbose: false } });
  });

  test('before the command, the word is the flag value, not the command name', () => {
    const route = routeCliArgv(['--json', 'false', 'list', 'x'], 'run');
    expect(route.command).toBe('list');
    expect(route.commandArgv).toEqual(['--json', 'false', 'x']);
  });
});
