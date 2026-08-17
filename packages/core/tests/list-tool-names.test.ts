/**
 * `listToolNames` — the tool-name baseline. It must mirror the real mounts
 * exactly (built on `collectTools`): derived + overridden names, expose
 * filters, CLI opt-in, multipart exclusion, stable sort — so a consumer's
 * snapshot test catches a derived-name drift across upgrades.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { listContractToolNames, listToolNames } from '../src/tools';

const Ok = z.object({ ok: z.boolean() });

const videos = defineContract(
  { prefix: 'videos' },
  {
    list: { method: 'GET', path: '/', desc: 'List videos', output: z.array(z.string()) },
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get a video',
      params: z.object({ id: z.string() }),
      output: z.string(),
    },
    transcode: {
      method: 'POST',
      path: '/:id/transcode',
      desc: 'Transcode a video',
      params: z.object({ id: z.string() }),
      toolName: 'transcode_video_now',
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
      output: Ok,
    },
    internal: {
      method: 'POST',
      path: '/internal',
      desc: 'HTTP only',
      expose: ['HTTP'],
      output: Ok,
    },
    mcpOnly: {
      method: 'POST',
      path: '/mcp-only',
      desc: 'MCP only',
      expose: ['MCP'],
      output: Ok,
    },
    upload: {
      method: 'POST',
      path: '/upload',
      desc: 'Upload a video',
      multipart: { files: { file: {} } },
      output: Ok,
    },
  },
);

const analytics = defineContract(
  { prefix: 'analytics' },
  {
    run: { method: 'POST', path: '/run', desc: 'Run analytics', output: Ok },
  },
);

const videoService = implement(videos, {
  list: () => [],
  get: () => 'v',
  transcode: () => ({ ok: true }),
  internal: () => ({ ok: true }),
  mcpOnly: () => ({ ok: true }),
  upload: () => ({ ok: true }),
});

const analyticsService = implement(analytics, {
  run: () => ({ ok: true }),
});

describe('listToolNames', () => {
  const entries = listToolNames({ services: [videoService, analyticsService] });

  test('resolves derived and overridden names with (service, method) identity', () => {
    expect(entries).toEqual([
      {
        kind: 'contract',
        name: 'get_video',
        service: 'videos',
        method: 'get',
        transports: ['MCP', 'AGENT'],
      },
      {
        kind: 'contract',
        name: 'list_videos',
        service: 'videos',
        method: 'list',
        transports: ['MCP', 'AGENT'],
      },
      {
        kind: 'contract',
        name: 'mcp_only_video',
        service: 'videos',
        method: 'mcpOnly',
        transports: ['MCP'],
      },
      {
        kind: 'contract',
        name: 'run_analytics',
        service: 'analytics',
        method: 'run',
        transports: ['MCP', 'AGENT'],
      },
      {
        kind: 'contract',
        name: 'transcode_video_now',
        service: 'videos',
        method: 'transcode',
        transports: ['MCP', 'AGENT', 'CLI'],
      },
    ]);
  });

  test('HTTP-only and multipart endpoints never appear', () => {
    const methods = entries.map((e) => e.method);
    expect(methods).not.toContain('internal');
    expect(methods).not.toContain('upload');
  });

  test('CLI is opt-in — only the endpoint that lists it carries the transport', () => {
    const withCli = entries.filter((e) => e.transports.includes('CLI'));
    expect(withCli.map((e) => e.name)).toEqual(['transcode_video_now']);
  });

  test('output is sorted by name — a stable snapshot shape', () => {
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('listContractToolNames', () => {
  test('matches listToolNames over the implemented services, byte for byte', () => {
    expect(listContractToolNames([videos, analytics])).toEqual(
      listToolNames({ services: [videoService, analyticsService] }),
    );
  });

  test('covers a streaming multipart contract without any handler', () => {
    const media = defineContract(
      { prefix: 'media', scope: 'user' },
      {
        stream: {
          method: 'POST',
          path: '/stream',
          desc: 'Stream upload',
          multipart: { delivery: 'stream' as const, files: { file: {} } },
          output: Ok,
        },
        note: { method: 'POST', path: '/note', desc: 'Add a note', output: Ok },
      },
    );

    const entries = listContractToolNames([media]);
    // The streaming endpoint is never a tool; the plain one is, with no
    // handler ever having been written.
    expect(entries.map((entry) => entry.name)).toEqual(['note_media']);
  });
});
