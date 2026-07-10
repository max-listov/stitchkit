/**
 * `summarizeTransports` — per-transport operation counts, mirroring the real
 * mounts (multipart is HTTP-only, CLI is opt-in, MCP/AGENT default-on).
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { summarizeTransports } from '../src/tools';

const Ok = z.object({ ok: z.boolean() });

const widgets = defineContract(
  { prefix: 'widgets' },
  {
    list: { method: 'GET', path: '/', desc: 'List', output: z.array(z.string()) }, // HTTP+MCP+AGENT
    create: { method: 'POST', path: '/', desc: 'Create', output: Ok }, // HTTP+MCP+AGENT
    sync: { method: 'POST', path: '/sync', desc: 'Sync', expose: ['HTTP'], output: Ok }, // HTTP only
    run: {
      method: 'POST',
      path: '/run',
      desc: 'Run',
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
      output: Ok,
    }, // all four
    upload: { method: 'POST', path: '/upload', desc: 'Upload', multipart: 'file', output: Ok }, // HTTP only (multipart)
  },
);

const service = implement(widgets, {
  list: () => [],
  create: () => ({ ok: true }),
  sync: () => ({ ok: true }),
  run: () => ({ ok: true }),
  upload: () => ({ ok: true }),
});

describe('summarizeTransports', () => {
  const summary = summarizeTransports([service]);

  test('counts each transport correctly', () => {
    // HTTP: all 5 (incl. multipart + HTTP-only). MCP/AGENT: list/create/run = 3
    // (sync HTTP-only and upload multipart are excluded). CLI: run only.
    expect(summary.totals).toEqual({ HTTP: 5, MCP: 3, AGENT: 3, CLI: 1 });
  });

  test('reports the service count and per-service breakdown', () => {
    expect(summary.services).toBe(1);
    expect(summary.perService).toEqual([
      { service: 'widgets', counts: { HTTP: 5, MCP: 3, AGENT: 3, CLI: 1 } },
    ]);
  });

  test('totals sum across multiple services', () => {
    const other = implement(
      defineContract(
        { prefix: 'gadgets' },
        { list: { method: 'GET', path: '/', desc: 'List', output: z.array(z.string()) } },
      ),
      { list: () => [] },
    );
    const multi = summarizeTransports([service, other]);
    expect(multi.services).toBe(2);
    expect(multi.totals).toEqual({ HTTP: 6, MCP: 4, AGENT: 4, CLI: 1 });
  });
});
