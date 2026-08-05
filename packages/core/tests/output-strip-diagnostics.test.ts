/**
 * The output strip is correct — the contract is the published shape of the
 * response — but it is invisible: types cannot catch it (structural typing does
 * not reject excess properties) and nothing logs it. `warnOnOutputStrip` makes it
 * visible on demand, and costs nothing when off. → ADR 0037.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { validateHandlerOutput } from '../src/internal/errors';
import { createHandler, implement } from '../src/server';
import { collectTools, createToolRunner } from '../src/tools/mount';

const OUT = z.object({ id: z.string(), nested: z.object({ keep: z.string() }) });

/** A logger that only records warnings — the rest is noise for these tests. */
function silentLogger(lines: string[]) {
  const noop = (): undefined => undefined;
  return { info: noop, warn: (m: string) => void lines.push(m), error: noop, debug: noop };
}

/** A service whose handler returns more than the contract declares. */
function leakyService() {
  const contract = defineContract(
    { prefix: 'notes' },
    { get: { method: 'GET', path: '/', desc: 'Get a note', output: OUT } },
  );
  return implement(contract, {
    get: () => ({
      id: '1',
      secret: 'internal',
      nested: { keep: 'yes', alsoSecret: 42 },
    }),
  });
}

describe('validateHandlerOutput — the diff itself', () => {
  test('reports top-level and nested paths', () => {
    const paths: string[] = [];
    validateHandlerOutput(
      OUT,
      { id: '1', secret: 'x', nested: { keep: 'y', alsoSecret: 1 } },
      (p) => paths.push(...p),
    );
    expect(paths).toEqual(['secret', 'nested.alsoSecret']);
  });

  test('walks arrays by index', () => {
    const schema = z.object({ rows: z.array(z.object({ a: z.string() })) });
    const paths: string[] = [];
    validateHandlerOutput(
      schema,
      { rows: [{ a: 'x', b: 1 }, { a: 'y' }, { a: 'z', c: 2 }] },
      (p) => paths.push(...p),
    );
    expect(paths).toEqual(['rows[0].b', 'rows[2].c']);
  });

  test('a clean output reports nothing — the callback never fires', () => {
    let fired = false;
    validateHandlerOutput(OUT, { id: '1', nested: { keep: 'y' } }, () => {
      fired = true;
    });
    expect(fired).toBe(false);
  });

  test('a loose schema keeps its extras, so there is nothing to report', () => {
    let fired = false;
    const loose = z.object({ id: z.string() }).loose();
    const result = validateHandlerOutput(loose, { id: '1', extra: 7 }, () => {
      fired = true;
    });
    expect(fired).toBe(false);
    expect(result.ok && result.data).toEqual({ id: '1', extra: 7 });
  });

  test('no reporter → no walk, and the result is unchanged', () => {
    const result = validateHandlerOutput(OUT, {
      id: '1',
      secret: 'x',
      nested: { keep: 'y', alsoSecret: 1 },
    });
    expect(result.ok && result.data).toEqual({ id: '1', nested: { keep: 'y' } });
  });
});

describe('HTTP transport — warnOnOutputStrip', () => {
  test('off by default: the logger is never touched', async () => {
    const lines: string[] = [];
    const handler = createHandler({
      services: [leakyService()],
      logging: silentLogger(lines),
    });
    const res = await handler(new Request('http://x/notes'));
    expect(res.status).toBe(200);
    // The strip still happens — that part is contract behaviour, not diagnostics.
    expect(await res.json()).toEqual({ id: '1', nested: { keep: 'yes' } });
    expect(lines).toEqual([]);
  });

  test('on: the dropped paths and the endpoint identity are reported', async () => {
    const lines: string[] = [];
    const handler = createHandler({
      services: [leakyService()],
      warnOnOutputStrip: true,
      logging: silentLogger(lines),
    });
    await handler(new Request('http://x/notes'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('notes.get');
    expect(lines[0]).toContain('secret');
    expect(lines[0]).toContain('nested.alsoSecret');
  });
});

describe('tool transports strip identically — and report identically', () => {
  test('a tool call reports the same paths, with the tool name', async () => {
    const seen: Array<{ tool: string; paths: string[] }> = [];
    const [mountable] = collectTools(leakyService(), 'MCP');
    if (!mountable) throw new Error('expected a tool');
    const run = createToolRunner({
      source: 'mcp',
      onOutputStrip: (tool, paths) => seen.push({ tool, paths }),
    });
    const result = await run(mountable, {});
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ tool: 'get_note', paths: ['secret', 'nested.alsoSecret'] }]);
  });

  test('without a reporter a tool call behaves exactly as before', async () => {
    const [mountable] = collectTools(leakyService(), 'MCP');
    if (!mountable) throw new Error('expected a tool');
    const result = await createToolRunner({ source: 'mcp' })(mountable, {});
    expect(result.ok && result.data).toEqual({ id: '1', nested: { keep: 'yes' } });
  });
});
