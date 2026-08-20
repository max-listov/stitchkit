/**
 * Security regressions — locks in the audit fixes: prototype-pollution
 * defence, CORS credential safety, SSRF numeric-host rejection, path
 * containment.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedFileBoundary, type ManagedFileBoundary } from '../src/files/boundary';
import { isUnsafeKey, safeJsonParse } from '../src/internal/safe-json';
import { isWithinDir } from '../src/internal/within-dir';
import { staticRoute } from '../src/server/file';
import { parseCookies } from '../src/server/middleware/cookies';
import { assertCorsConfig, corsHeaders } from '../src/server/middleware/cors';
import { parseQueryParams } from '../src/server/request';
import { resolveMedia } from '../src/tools/view-file';

describe('safeJsonParse — prototype pollution', () => {
  test('drops __proto__ from a parsed object', () => {
    const parsed = safeJsonParse('{"__proto__":{"polluted":true},"ok":1}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed) === Object.prototype).toBe(true);
    expect((parsed as Record<string, unknown>).ok).toBe(1);
  });

  test('keeps legitimate data named constructor / prototype', () => {
    // Only `__proto__` pollutes via assignment; `constructor` / `prototype`
    // as own data keys are inert and must not be dropped.
    const parsed = safeJsonParse('{"constructor":1,"prototype":2,"safe":3}');
    expect(Object.hasOwn(parsed as object, 'constructor')).toBe(true);
    expect(Object.hasOwn(parsed as object, 'prototype')).toBe(true);
    expect((parsed as Record<string, unknown>).safe).toBe(3);
  });

  test('throws on invalid JSON, like JSON.parse', () => {
    expect(() => safeJsonParse('{not json')).toThrow();
  });

  test('isUnsafeKey flags __proto__ only', () => {
    expect(isUnsafeKey('__proto__')).toBe(true);
    expect(isUnsafeKey('constructor')).toBe(false);
    expect(isUnsafeKey('prototype')).toBe(false);
    expect(isUnsafeKey('userId')).toBe(false);
  });
});

describe('parseCookies — prototype pollution + malformed segments', () => {
  test('skips a __proto__ cookie', () => {
    const cookies = parseCookies('__proto__=x; sid=abc');
    expect(cookies.sid).toBe('abc');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('skips a segment with no `=`', () => {
    const cookies = parseCookies('flag; sid=abc');
    expect('flag' in cookies).toBe(false);
    expect(cookies.sid).toBe('abc');
  });
});

describe('parseQueryParams — prototype pollution', () => {
  test('skips a ?__proto__= key', () => {
    const query = parseQueryParams(new URL('http://x/?__proto__=evil&page=2'));
    expect(Object.hasOwn(query, '__proto__')).toBe(false);
    expect(query.page).toBe('2');
  });
});

describe('assertCorsConfig — credentialed wildcard', () => {
  test('throws on credentials + wildcard origin', () => {
    expect(() => assertCorsConfig({ origin: '*', credentials: true })).toThrow();
  });

  test('throws on credentials + omitted origin', () => {
    expect(() => assertCorsConfig({ credentials: true })).toThrow();
  });

  test('accepts credentials + an explicit origin list', () => {
    expect(() =>
      assertCorsConfig({ origin: ['https://app.example'], credentials: true }),
    ).not.toThrow();
  });
});

describe('corsHeaders — no credentials on a rejected origin', () => {
  test('a non-allowlisted origin gets neither Allow-Origin nor Allow-Credentials', () => {
    const headers = corsHeaders(
      { origin: ['https://app.example'], credentials: true },
      'https://evil.example',
    );
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  test('an allowlisted origin gets both', () => {
    const headers = corsHeaders(
      { origin: ['https://app.example'], credentials: true },
      'https://app.example',
    );
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  test('origin match is case-insensitive', () => {
    const headers = corsHeaders({ origin: ['https://App.Example'] }, 'https://app.example');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example');
  });
});

describe('isWithinDir — path containment', () => {
  test('a path inside the root passes', () => {
    expect(isWithinDir('/srv/static', '/srv/static/css/app.css')).toBe(true);
  });

  test('the root itself passes', () => {
    expect(isWithinDir('/srv/static', '/srv/static')).toBe(true);
  });

  test('an escaping path is rejected', () => {
    expect(isWithinDir('/srv/static', '/srv/secrets')).toBe(false);
    expect(isWithinDir('/srv/static', '/etc/passwd')).toBe(false);
  });

  test('a sibling with a shared prefix is rejected', () => {
    expect(isWithinDir('/srv/static', '/srv/static-evil/x')).toBe(false);
  });

  // A trailing separator on root used to make `root + sep` end in `//`, which no
  // real path starts with — silently turning the check into allow-nothing.
  test('a trailing separator on root is normalised, not an accidental allow-nothing', () => {
    expect(isWithinDir('/srv/static/', '/srv/static/app.css')).toBe(true);
    expect(isWithinDir('/srv/static/', '/srv/static')).toBe(true);
  });

  test('root "/" correctly contains every absolute path', () => {
    expect(isWithinDir('/', '/etc/passwd')).toBe(true);
    expect(isWithinDir('/', '/')).toBe(true);
  });

  test('the shared-prefix guard still holds with a trailing-separator root', () => {
    expect(isWithinDir('/srv/static/', '/srv/static-evil/x')).toBe(false);
  });
});

describe('staticRoute — real path containment', () => {
  let base = '';
  let root = '';

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'sk-static-'));
    root = join(base, 'public');
    await mkdir(root);
    await writeFile(join(root, 'inside.txt'), 'public');
    await writeFile(join(base, 'secret.txt'), 'private');
    await symlink(join(base, 'secret.txt'), join(root, 'escape.txt'));
  });

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  test('serves an ordinary in-root file', async () => {
    const route = staticRoute('/assets', root);
    const response = await route.handler(new Request('http://localhost/assets/inside.txt'), {
      params: { filePath: 'inside.txt' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('public');
  });

  test('does not follow an in-root symlink outside the root', async () => {
    const route = staticRoute('/assets', root);
    const response = await route.handler(new Request('http://localhost/assets/escape.txt'), {
      params: { filePath: 'escape.txt' },
    });
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('private');
  });
});

describe('resolveMedia — local-file sandbox', () => {
  let base = '';
  let root = '';
  let files: ManagedFileBoundary;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'sk-vf-'));
    root = join(base, 'sandbox');
    await mkdir(root);
    await writeFile(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'secret.json'), '{"apiKey":"ggk_secret"}');
    await writeFile(join(base, 'outside.png'), Buffer.from([1, 2, 3]));
    await symlink(join(base, 'outside.png'), join(root, 'link.png'));
    files = await createManagedFileBoundary({ root });
  });

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  test('reads a media file inside the sandbox', async () => {
    const content = await resolveMedia('pic.png', { files });
    expect(content[0]?.type).toBe('image');
  });

  test('refuses a non-media file even inside the sandbox', async () => {
    // The ggk_ key lives in a config.json — a media-only allowlist blocks it.
    await expect(resolveMedia('secret.json', { files })).rejects.toThrow(/non-media/);
  });

  test('refuses a path escaping the sandbox', async () => {
    await expect(resolveMedia('../outside.png', { files })).rejects.toThrow(/invalid/);
  });

  test('refuses a symlink that points outside the sandbox', async () => {
    await expect(resolveMedia('link.png', { files })).rejects.toThrow(/escapes/);
  });

  test('local file access is disabled without a managed boundary', async () => {
    await expect(resolveMedia('pic.png')).rejects.toThrow(/disabled/);
  });
});

describe('resolveMedia — video bodies are never downloaded', () => {
  test('a video/* Content-Type returns a link without consuming the body', async () => {
    // The body drips forever — if the implementation read it before deciding
    // "video is a link, not an inline block", this would hang / buffer 20 MiB.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024));
              // …never closes: only a cancelled body lets the test finish fast.
            },
          }),
          { headers: { 'content-type': 'video/mp4' } },
        ),
    });
    try {
      const startedAt = performance.now();
      const content = await resolveMedia(`http://127.0.0.1:${server.port}/clip`, {
        allowPrivateHosts: true,
      });
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(content).toEqual([
        { type: 'text', text: `[video] video/mp4 — http://127.0.0.1:${server.port}/clip` },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
