/**
 * Aggregate views over a CLI result.
 *
 * The cost these exist for is measurable and one-sided: a 98-record listing is
 * ~35 000 characters in an agent's context window, and the question asked was
 * "how many per status". `| jq` arrives too late — the bytes are already in the
 * conversation. So the aggregate is computed before anything is written.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { createCli } from '../src/tools/cli';

const STATUSES = ['active', 'idle', 'stopped'] as const;
/** 98 records — the size the measurement in the report was taken at. */
const ITEMS = Array.from({ length: 98 }, (_, index) => ({
  id: `item-${index}`,
  status: STATUSES[index % STATUSES.length] ?? 'active',
  messages: index,
}));

const contract = defineContract(
  { prefix: 'items', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List items',
      toolName: 'item_list',
      expose: ['CLI'],
      output: z.object({
        items: z.array(z.object({ id: z.string(), status: z.string(), messages: z.number() })),
      }),
    },
    one: {
      method: 'GET',
      path: '/one',
      desc: 'A single item',
      toolName: 'item_one',
      expose: ['CLI'],
      output: z.object({ id: z.string() }),
    },
  },
);

const service = implement(contract, {
  list: () => ({ items: ITEMS }),
  one: () => ({ id: 'item-0' }),
});

async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'items',
    version: '1.0.0',
    services: [service],
    argv,
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

describe('createCli — aggregate views', () => {
  test('--count-by prints one line per distinct value, not the collection', async () => {
    const { out, code } = await run(['item_list', '--count-by', 'status']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ active: 33, idle: 33, stopped: 32 });
    // The whole point: the answer is two orders of magnitude smaller.
    const full = await run(['item_list', '--json']);
    expect(out.length).toBeLessThan(full.out.length / 10);
  });

  test('--count-by orders by size so --top takes a defined slice', async () => {
    const { out } = await run(['item_list', '--count-by', 'status', '--top', '2']);
    expect(Object.keys(JSON.parse(out))).toEqual(['active', 'idle']);
  });

  test('--top with --by is the same view, written the other way round', async () => {
    const top = await run(['item_list', '--top', '1', '--by', 'status']);
    const countBy = await run(['item_list', '--count-by', 'status', '--top', '1']);
    expect(top.out).toBe(countBy.out);
  });

  test('--sum totals a numeric field, and --by groups the total', async () => {
    const total = await run(['item_list', '--sum', 'messages']);
    expect(JSON.parse(total.out)).toBe(ITEMS.reduce((sum, item) => sum + item.messages, 0));

    const grouped = await run(['item_list', '--sum', 'messages', '--by', 'status']);
    const parsed: Record<string, number> = JSON.parse(grouped.out);
    expect(Object.keys(parsed).sort()).toEqual(['active', 'idle', 'stopped']);
    expect(Object.values(parsed).reduce((sum, value) => sum + value, 0)).toBe(
      ITEMS.reduce((sum, item) => sum + item.messages, 0),
    );
  });

  test('--table is the one human-facing shape and stays opt-in', async () => {
    const { out, code } = await run(['item_list', '--table', 'id,status']);
    expect(code).toBe(0);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('id       status');
    expect(lines[1]).toBe('-------  -------');
    expect(lines).toHaveLength(ITEMS.length + 2);
  });

  test('a field the result does not carry is an argument error, never an empty group', async () => {
    const { out, err, code } = await run(['item_list', '--count-by', 'stat']);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('no record carries the field "stat"');
    // The message names what the caller could have meant.
    expect(err).toContain('status');
  });

  test('an aggregate over a scalar result is an argument error', async () => {
    const { err, code } = await run(['item_one', '--count-by', 'id']);
    expect(code).toBe(2);
    expect(err).toContain('needs a collection');
  });

  test('two aggregates at once are refused before the command runs', async () => {
    const { err, code } = await run([
      'item_list',
      '--count-by',
      'status',
      '--sum',
      'messages',
    ]);
    expect(code).toBe(2);
    expect(err).toContain('different shapes');
  });

  test('--by alone has nothing to group', async () => {
    const { err, code } = await run(['item_list', '--by', 'status']);
    expect(code).toBe(2);
    expect(err).toContain('--by groups a view');
  });

  test('--sum refuses a field that is not a number', async () => {
    const { err, code } = await run(['item_list', '--sum', 'status']);
    expect(code).toBe(2);
    expect(err).toContain('is not a number');
  });

  test('without a view flag the output is byte-for-byte what it was', async () => {
    const { out } = await run(['item_list', '--json']);
    expect(out).toBe(`${JSON.stringify({ items: ITEMS })}\n`);
  });

  test('a view flag never reaches the tool arguments', async () => {
    const { out } = await run(['item_list', '--count-by', 'status', '--dry-run']);
    expect(JSON.parse(out)).toEqual({ command: 'item_list', args: {} });
  });

  test('the views are listed in help', async () => {
    const { out } = await run(['--help']);
    expect(out).toContain('--count-by <field>');
    expect(out).toContain('--table <a,b>');
  });
});
