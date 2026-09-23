/**
 * The 0.94.0 codemod moves an endpoint's tool options into `tool` and touches
 * nothing else. Its output is fed back through `defineContract`, so "moved" means
 * "a contract that now defines", not "text that looks right".
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files, moveToolOptions } from '../scripts/codemod-tool-group';

const run = (text: string) => moveToolOptions('fixture.ts', text);

describe('the tool-group codemod', () => {
  test('moves every tool option of a multi-line endpoint into one group', () => {
    const before = `const c = {
  list: {
    method: 'GET',
    path: '/',
    desc: 'List',
    toolName: 'user_list',
    annotations: { readOnlyHint: true },
    output: Out,
  },
};`;
    const result = run(before);
    expect(result.moved).toBe(2);
    expect(result.text).not.toContain('toolName');
    expect(result.text).toContain(
      "tool: { name: 'user_list', annotations: { readOnlyHint: true } },",
    );
    expect(result.text).toContain('output: Out,');
  });

  test('carries the comment written above a moved option into the group', () => {
    const before = `const c = {
  list: {
    method: 'GET',
    path: '/',
    desc: 'List',
    // the name agents already know
    toolName: 'user_list',
    output: Out,
  },
};`;
    const result = run(before);
    expect(result.text).toContain(`    tool: {
      // the name agents already know
      name: 'user_list',
    },`);
  });

  test('leaves the tool options of an HTTP-only endpoint to a person', () => {
    // Moved, they would be refused ("not exposed on any tool transport"); they
    // never reached a tool, so the edit is deleting them — not the codemod's call.
    const text =
      "const e = { method: 'GET', path: '/', desc: 'd', expose: ['HTTP'], annotations: { title: 'T' } };";
    const result = run(text);
    expect(result.text).toBe(text);
    expect(result.moved).toBe(0);
    expect(result.skipped).toEqual([
      'fixture.ts:1 — exposed on HTTP only, so these tool options never reached a tool; delete them',
    ]);
  });

  test('extends an existing tool group instead of writing a second one', () => {
    const result = run(
      "const e = { method: 'POST', path: '/', desc: 'd', mcp, tool: { ui: widget } };",
    );
    expect(result.moved).toBe(1);
    expect(result.text).toBe(
      "const e = { method: 'POST', path: '/', desc: 'd', tool: { ui: widget, mcp } };",
    );
  });

  test('keeps a single-line endpoint on one line', () => {
    const result = run("const e = { method: 'GET', path: '/', desc: 'd', toolName: 'x' };");
    expect(result.text).toBe(
      "const e = { method: 'GET', path: '/', desc: 'd', tool: { name: 'x' } };",
    );
  });

  test('leaves a built MethodDef and a runtime tool flat', () => {
    const method =
      "const m = { method: 'GET', path: '/', desc: 'd', key: 'k', serviceName: 's', toolName: 'x' };";
    const runtime =
      "const r = defineRuntimeTool({ name: 'x', description: 'd', annotations: { title: 'T' } });";
    expect(run(method)).toEqual({ text: method, moved: 0, skipped: [] });
    expect(run(runtime)).toEqual({ text: runtime, moved: 0, skipped: [] });
  });

  test('leaves an endpoint with a spread to a person and says where', () => {
    const text = "const e = { ...base, method: 'GET', path: '/', desc: 'd', toolName: 'x' };";
    const result = run(text);
    expect(result.text).toBe(text);
    expect(result.skipped).toEqual([expect.stringContaining('fixture.ts:1')]);
  });

  test('its output defines: a moved endpoint passes defineContract, the old one is refused', async () => {
    const { defineContract } = await import('../src/entrypoints/contract');
    const { z } = await import('zod');
    const before =
      "({ method: 'GET', path: '/', desc: 'List', toolName: 'user_list', output: z.object({}) })";
    const after = run(`const e = ${before};`)
      .text.replace(/^const e = /, '')
      .replace(/;$/, '');
    const evaluate = (source: string): unknown => new Function('z', `return ${source}`)(z);
    expect(() => defineContract({ prefix: 'u' }, { list: evaluate(before) } as never)).toThrow(
      /sets `toolName` — tool options live in `tool` since 0\.94\.0: use tool\.name/,
    );
    const contract: { endpoints: Record<string, { tool?: unknown }> } = defineContract(
      { prefix: 'u' },
      { list: evaluate(after) } as never,
    );
    expect(contract.endpoints.list?.tool).toEqual({ name: 'user_list' });
  });

  test('walks past a socket a running app left in the tree', async () => {
    // A project's runtime state (`.stitchkit/…/*.sock`) sits beside its source;
    // the walk read every non-file as a directory and threw on the first one.
    const root = mkdtempSync(join(tmpdir(), 'codemod-walk-'));
    const server = createServer();
    try {
      mkdirSync(join(root, 'state'));
      writeFileSync(join(root, 'contract.ts'), '');
      await new Promise<void>((resolve) =>
        server.listen(join(root, 'state', 'app.sock'), resolve),
      );
      expect([...files(root)]).toEqual([join(root, 'contract.ts')]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
