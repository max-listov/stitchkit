import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AuthorizationCodeClientError,
  type AuthorizationCodeCrypto,
  type AuthorizationCodeStorage,
  createAuthorizationCodeClient,
  safeInternalReturnPath,
} from '../src/oauth';

class MemoryStorage implements AuthorizationCodeStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function deterministicCrypto(): AuthorizationCodeCrypto {
  let offset = 0;
  return {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (offset + index) % 256;
      }
      offset += bytes.length;
      return bytes;
    },
    subtle: globalThis.crypto.subtle,
  };
}

function client(storage = new MemoryStorage()) {
  return {
    storage,
    oauth: createAuthorizationCodeClient({
      authorizationEndpoint: 'https://accounts.example.com/authorize?existing=kept',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/auth/callback',
      scopes: ['openid', 'email'],
      storage,
      storageKey: 'oauth:pending',
      contextSchema: z.object({ mode: z.enum(['login', 'link']), returnTo: z.string() }),
      authorizationParameters: { prompt: 'select_account' },
      crypto: deterministicCrypto(),
    }),
  };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AuthorizationCodeClientError ? error.code : undefined;
  }
  return undefined;
}

describe('browser Authorization Code + PKCE client', () => {
  test('builds the complete request and consumes the transaction once', async () => {
    const { oauth } = client();
    const begun = await oauth.begin({ context: { mode: 'login', returnTo: '/account' } });
    const url = new URL(begun.authorizationUrl);
    expect(url.searchParams.get('existing')).toBe('kept');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const consumed = oauth.consume({ state });
    expect(consumed).toEqual({
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: url.searchParams.get('nonce') ?? '',
      redirectUri: 'https://app.example.com/auth/callback',
      context: { mode: 'login', returnTo: '/account' },
    });
    expect(errorCode(() => oauth.consume({ state }))).toBe('MISSING_TRANSACTION');
  });

  test('independent operations mint different state, nonce and verifier', async () => {
    const { oauth } = client();
    const first = new URL(
      (await oauth.begin({ context: { mode: 'login', returnTo: '/' } })).authorizationUrl,
    );
    const firstState = first.searchParams.get('state') ?? '';
    const firstConsumed = oauth.consume({ state: firstState });
    const second = new URL(
      (await oauth.begin({ context: { mode: 'link', returnTo: '/' } })).authorizationUrl,
    );
    const secondState = second.searchParams.get('state') ?? '';
    const secondConsumed = oauth.consume({ state: secondState });
    expect(new Set([firstState, secondState]).size).toBe(2);
    expect(
      new Set([first.searchParams.get('nonce'), second.searchParams.get('nonce')]).size,
    ).toBe(2);
    expect(new Set([firstConsumed.codeVerifier, secondConsumed.codeVerifier]).size).toBe(2);
  });

  test('reserved parameters are rejected before storage mutation', () => {
    const storage = new MemoryStorage();
    expect(() =>
      createAuthorizationCodeClient({
        authorizationEndpoint: 'https://accounts.example.com/authorize',
        clientId: 'client',
        redirectUri: 'https://app.example.com/callback',
        scopes: ['openid'],
        storage,
        storageKey: 'pending',
        contextSchema: z.object({}),
        authorizationParameters: { state: 'attacker-controlled' },
      }),
    ).toThrow(AuthorizationCodeClientError);
    expect(storage.writes).toBe(0);
  });

  test('every rejected stored transaction is removed before validation', () => {
    const cases = [
      { raw: '{', state: 'x', code: 'MALFORMED_TRANSACTION' },
      {
        raw: JSON.stringify({ version: 2 }),
        state: 'x',
        code: 'UNSUPPORTED_TRANSACTION_VERSION',
      },
      {
        raw: JSON.stringify({
          version: 1,
          state: 'right',
          nonce: 'nonce',
          codeVerifier: 'verifier',
          redirectUri: 'https://app.example.com/callback',
          context: { mode: 'unknown', returnTo: '/' },
        }),
        state: 'right',
        code: 'INVALID_CONTEXT',
      },
      {
        raw: JSON.stringify({
          version: 1,
          state: 'right',
          nonce: 'nonce',
          codeVerifier: 'verifier',
          redirectUri: 'https://app.example.com/callback',
          context: { mode: 'login', returnTo: '/' },
        }),
        state: 'wrong',
        code: 'STATE_MISMATCH',
      },
    ];
    for (const fixture of cases) {
      const { oauth, storage } = client();
      storage.values.set('oauth:pending', fixture.raw);
      expect(errorCode(() => oauth.consume({ state: fixture.state }))).toBe(fixture.code);
      expect(storage.getItem('oauth:pending')).toBeNull();
    }
  });

  test('keeps only single-slash paths without backslashes or controls', () => {
    const fallback = '/safe';
    expect(safeInternalReturnPath('//evil.example', fallback)).toBe(fallback);
    expect(safeInternalReturnPath('/\\evil', fallback)).toBe(fallback);
    expect(safeInternalReturnPath('/line\r\nbreak', fallback)).toBe(fallback);
    expect(safeInternalReturnPath('/nul\0byte', fallback)).toBe(fallback);
    expect(safeInternalReturnPath('/account?tab=auth', fallback)).toBe('/account?tab=auth');
  });
});
