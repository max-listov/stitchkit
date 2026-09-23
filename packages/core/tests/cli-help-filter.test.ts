import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { createCli } from '../src/tools/cli/create-cli';

/**
 * A large surface. On a discovered CLI this is 205 commands and 230 lines, at
 * which point `--help` stops being an answer: it scrolls past a person and costs
 * an agent the same context an unfiltered result would.
 */
const contract = defineContract(
  { prefix: 'ops', scope: 'public' },
  {
    sendBroadcast: {
      method: 'POST',
      path: '/broadcast',
      desc: 'Send a broadcast to every subscriber',
      expose: ['CLI'],
      input: z.object({ text: z.string() }),
      tool: { name: 'broadcast_send' },
    },
    cancelBroadcast: {
      method: 'POST',
      path: '/broadcast/cancel',
      desc: 'Stop a running broadcast',
      expose: ['CLI'],
      tool: { name: 'broadcast_cancel' },
    },
    listItems: {
      method: 'GET',
      path: '/items',
      desc: 'List every item',
      expose: ['CLI'],
      tool: { name: 'item_list' },
    },
    announce: {
      method: 'POST',
      path: '/announce',
      // The word lives in the sentence, not in the name — which is the usual
      // case for the word a reader actually knows.
      desc: 'Publish an announcement as a broadcast',
      expose: ['CLI'],
      tool: { name: 'announce_publish' },
    },
  },
);

const service = implement(contract, {
  sendBroadcast: () => undefined,
  cancelBroadcast: () => undefined,
  listItems: () => undefined,
  announce: () => undefined,
});

async function run(
  argv: string[],
  defaultCommand?: string,
): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'ops',
    version: '1.0.0',
    services: [service],
    argv,
    ...(defaultCommand && { defaultCommand }),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { out, err, code };
}

describe('createCli — a narrower question than "all of them"', () => {
  test('--help <substring> lists only the matching commands, and says how many of the total', async () => {
    const { out, code } = await run(['--help', 'broadcast']);
    expect(code).toBe(0);
    expect(out).toContain('Commands matching "broadcast" (3 of 4)');
    expect(out).toContain('broadcast_send');
    expect(out).toContain('broadcast_cancel');
    // Matched on its description, not its name.
    expect(out).toContain('announce_publish');
    expect(out).not.toContain('item_list');
  });

  test('the one-line descriptions are the same ones bare --help shows', async () => {
    const { out } = await run(['--help', 'item']);
    expect(out).toContain('List every item');
  });

  test('bare --help stays exactly as it was', async () => {
    const { out, code } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Commands:');
    expect(out).not.toContain('Commands matching');
    expect(out).toContain('item_list');
    expect(out).toContain('Global options:');
  });

  test('no match is an exit code a script can branch on, not an empty success', async () => {
    const { out, err, code } = await run(['--help', 'nothing-like-this']);
    expect(code).toBe(4);
    expect(out).toBe('');
    expect(err).toContain('no command matches "nothing-like-this"');
    expect(err).toContain('4 available');
  });

  test('every form of the same question routes the same way', async () => {
    const dashDash = await run(['--help', 'broadcast']);
    for (const argv of [['-h', 'broadcast'], ['help', 'broadcast'], ['--help=broadcast']]) {
      expect((await run(argv)).out).toBe(dashDash.out);
    }
  });

  test('it works the same on a CLI that declares a default command', async () => {
    const { out, code } = await run(['--help', 'broadcast'], 'item_list');
    expect(code).toBe(0);
    expect(out).toContain('Commands matching "broadcast" (3 of 4)');
  });

  test('--help=false keeps the meaning it always had — the boolean negation', async () => {
    // `--help` is a reserved boolean, so the inline form was its negation long
    // before the filter existed. One value, one meaning: a boolean word is
    // still the boolean, and only a non-boolean narrows the listing.
    const { out, code } = await run(['--help=false'], 'item_list');
    expect(code).toBe(0);
    expect(out).not.toContain('Commands matching');
    expect(out).not.toContain('Usage:');
  });
});
