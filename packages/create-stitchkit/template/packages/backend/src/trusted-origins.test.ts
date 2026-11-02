import { describe, expect, test } from 'bun:test';
import { createTrustFence } from 'stitchkit/server';
import { trustedBrowserAuthorities } from './trusted-origins';

function proxied(origin: string): Request {
  return new Request('http://127.0.0.1:3211/api/board', {
    method: 'POST',
    headers: { host: '127.0.0.1:3211', origin },
  });
}

describe('a fenced API role behind the web role', () => {
  const fence = createTrustFence({
    trustedHosts: ['127.0.0.1:3211'],
    trustedOrigins: trustedBrowserAuthorities({
      PUBLIC_WEB_HOSTS: 'app.example, www.app.example:8443',
    }),
  });

  test('admits a browser on an address the deployment claims', () => {
    expect(fence.check(proxied('https://app.example'), 'http')).toBeUndefined();
    expect(fence.check(proxied('https://www.app.example:8443'), 'http')).toBeUndefined();
  });

  test('refuses a page anywhere else', () => {
    expect(fence.check(proxied('https://evil.example'), 'http')?.reason).toBe(
      'origin-mismatch',
    );
  });

  test('names each declared host once', () => {
    expect(
      trustedBrowserAuthorities({
        CORS_ORIGIN: 'https://app.example',
        PUBLIC_WEB_ORIGIN: 'https://app.example',
        PUBLIC_WEB_HOSTS: 'app.example,other.example',
      }),
    ).toEqual(['app.example', 'other.example']);
  });
});
