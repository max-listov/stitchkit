/**
 * The shared SSRF-guarded fetch + size-capped read (`internal/secure-fetch`),
 * behind `view_file`, `mountDownload` and the CLI downloader. Locks in the
 * private-host / numeric-disguise / scheme rejections and the per-redirect-hop
 * re-validation (a public host must not be able to `302` to an internal address
 * or a `file:` scheme), plus the body size cap.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import {
  assertPublicUrl,
  fetchGuarded,
  fetchPinnedDocument,
  isPrivateIp,
  readCapped,
} from '../src/internal/secure-fetch';

describe('isPrivateIp', () => {
  test('flags loopback / private / link-local / CGNAT / ULA', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '172.16.0.1',
      '100.64.0.1',
      '0.0.0.0',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '2002::1',
      '3fff::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a00:1',
      '::ffff:c0a8:1',
      '::ffff:a9fe:a9fe',
      '::ffff:6440:1',
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test('passes genuine public addresses', () => {
    for (const ip of [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
      '::ffff:808:808',
    ]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe('fetchPinnedDocument policy boundary', () => {
  test('rejects invalid limits before opening a socket', async () => {
    await expect(
      fetchPinnedDocument(new URL('https://1.1.1.1/'), { maxBytes: 0, timeoutMs: 1 }),
    ).rejects.toThrow(/maxBytes/);
    await expect(
      fetchPinnedDocument(new URL('https://1.1.1.1/'), { maxBytes: 1, timeoutMs: 0 }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      fetchPinnedDocument(new URL('https://1.1.1.1/'), {
        maxBytes: 1,
        timeoutMs: 1,
        maxRedirects: -1,
      }),
    ).rejects.toThrow(/maxRedirects/);
  });

  test('enforces TLS, credential and private-address policy before network I/O', async () => {
    const options = { maxBytes: 1024, timeoutMs: 100, requireHttps: true };
    await expect(fetchPinnedDocument(new URL('http://1.1.1.1/'), options)).rejects.toThrow(
      /https/,
    );
    await expect(
      fetchPinnedDocument(new URL('https://user:pass@1.1.1.1/'), options),
    ).rejects.toThrow(/credentials/);
    await expect(fetchPinnedDocument(new URL('https://127.0.0.1/'), options)).rejects.toThrow(
      /private/,
    );
  });
});

describe('assertPublicUrl — SSRF guard', () => {
  test('rejects a non-http(s) scheme (file:)', async () => {
    await expect(assertPublicUrl(new URL('file:///etc/passwd'))).rejects.toThrow(/non-http/);
  });

  test('rejects a private / loopback / metadata address', async () => {
    for (const u of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://192.168.0.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a00:1]/',
    ]) {
      await expect(assertPublicUrl(new URL(u))).rejects.toThrow(/private/);
    }
  });

  test('rejects a numeric-IP host (WHATWG canonicalises 2130706433 / 0x7f000001 → 127.0.0.1)', async () => {
    // The URL parser normalises an integer / hex IPv4 to dotted form, so these
    // are caught as a private address; the `NUMERIC_HOST` regex is the belt for
    // forms the parser leaves un-normalised. Either way they must be blocked.
    await expect(assertPublicUrl(new URL('http://2130706433/'))).rejects.toThrow();
    await expect(assertPublicUrl(new URL('http://0x7f000001/'))).rejects.toThrow();
  });

  test('rejects localhost / .local / .internal', async () => {
    await expect(assertPublicUrl(new URL('http://localhost/'))).rejects.toThrow(/internal/);
    await expect(assertPublicUrl(new URL('http://svc.internal/'))).rejects.toThrow(/internal/);
  });

  test('allows a public IP literal (no DNS lookup needed)', async () => {
    await expect(assertPublicUrl(new URL('http://1.1.1.1/'))).resolves.toBeUndefined();
  });
});

describe('fetchGuarded — per-redirect-hop re-validation', () => {
  test('rejects a redirect to an internal address', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    try {
      await expect(fetchGuarded(new URL('http://1.1.1.1/'), false)).rejects.toThrow(/private/);
    } finally {
      spy.mockRestore();
    }
  });

  test('rejects a redirect to a file: scheme (no local-file read)', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
    );
    try {
      await expect(fetchGuarded(new URL('http://1.1.1.1/'), false)).rejects.toThrow(
        /non-http/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test('rejects a non-http(s) URL even when private hosts are allowed', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('should not fetch'));
    try {
      await expect(fetchGuarded(new URL('file:///etc/passwd'), true)).rejects.toThrow(
        /non-http/,
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('rejects a redirect to file: even when private hosts are allowed', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
    );
    try {
      await expect(fetchGuarded(new URL('http://127.0.0.1/'), true)).rejects.toThrow(
        /non-http/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test('returns a non-redirect response unchanged', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    try {
      const res = await fetchGuarded(new URL('http://1.1.1.1/'), false);
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  test('allowPrivate bypasses the host guard (trusted-network opt-in)', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    try {
      const res = await fetchGuarded(new URL('http://127.0.0.1/'), true);
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('readCapped — size cap', () => {
  test('reads a body under the cap', async () => {
    const buf = await readCapped(new Response(new Uint8Array([1, 2, 3])), 1024);
    expect(buf?.length).toBe(3);
  });

  test('returns null when the body exceeds the cap', async () => {
    const buf = await readCapped(new Response(new Uint8Array(100)), 10);
    expect(buf).toBeNull();
  });
});
