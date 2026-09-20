import { describe, expect, mock, spyOn, test } from 'bun:test';
import { inspect } from 'node:util';
import {
  createGoogleOidcClient,
  type GoogleOidcClaims,
  GoogleOidcError,
  type GoogleOidcExchangeInput,
} from '../src/google';

const REDIRECT = 'https://app.example.com/auth/google/callback';
const VALID_CLAIMS: GoogleOidcClaims = {
  sub: 'google-subject',
  email: 'person@example.com',
  emailVerified: true,
  nonce: 'expected-nonce',
  name: 'Person',
  picture: 'https://images.example.com/person.png',
};

function oidc(
  overrides: {
    exchange?: (input: GoogleOidcExchangeInput) => Promise<{ idToken: string }>;
    verify?: () => Promise<GoogleOidcClaims>;
    timeoutMs?: number;
  } = {},
) {
  const calls: GoogleOidcExchangeInput[] = [];
  const client = createGoogleOidcClient({
    clientId: 'google-client',
    clientSecret: 'google-secret',
    allowedRedirectUris: [REDIRECT],
    timeoutMs: overrides.timeoutMs ?? 100,
    tokenTransport: async (input) => {
      calls.push(input);
      return overrides.exchange?.(input) ?? { idToken: 'signed-id-token' };
    },
    idTokenVerifier: async () => overrides.verify?.() ?? VALID_CLAIMS,
  });
  return { client, calls };
}

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return error instanceof GoogleOidcError ? error.code : undefined;
  }
  return undefined;
}

async function capturedError(run: () => Promise<unknown>): Promise<GoogleOidcError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GoogleOidcError) return error;
    throw error;
  }
  throw new Error('Expected GoogleOidcError');
}

function exchange(client: ReturnType<typeof createGoogleOidcClient>) {
  return client.exchangeAuthorizationCode({
    code: 'authorization-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: REDIRECT,
    nonce: 'expected-nonce',
  });
}

describe('Google OIDC client', () => {
  test('rejects an unlisted redirect before any outbound call', async () => {
    const { client, calls } = oidc();
    expect(
      await codeOf(() =>
        client.exchangeAuthorizationCode({
          code: 'authorization-code',
          codeVerifier: 'pkce-verifier',
          redirectUri: 'https://evil.example/callback',
          nonce: 'expected-nonce',
        }),
      ),
    ).toBe('INVALID_CREDENTIAL');
    expect(calls).toHaveLength(0);
  });

  test('passes the exact code, verifier and redirect and returns identity only', async () => {
    const { client, calls } = oidc();
    expect(await exchange(client)).toEqual({
      subject: 'google-subject',
      email: 'person@example.com',
      name: 'Person',
      picture: 'https://images.example.com/person.png',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.code).toBe('authorization-code');
    expect(calls[0]?.codeVerifier).toBe('pkce-verifier');
    expect(calls[0]?.redirectUri).toBe(REDIRECT);
    expect(JSON.stringify(await exchange(client))).not.toContain('token');
  });

  test('the production exchange sends exact form values and discards every provider token', async () => {
    let request: Request | undefined;
    const client = createGoogleOidcClient({
      clientId: 'google-client',
      clientSecret: 'google-secret',
      allowedRedirectUris: [REDIRECT],
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          id_token: 'signed-id-token',
          access_token: 'access-token',
          refresh_token: 'refresh-token',
        });
      },
      idTokenVerifier: async () => VALID_CLAIMS,
    });
    const identity = await exchange(client);
    const body = new URLSearchParams(await request?.text());
    expect(request?.url).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('authorization-code');
    expect(body.get('code_verifier')).toBe('pkce-verifier');
    expect(body.get('redirect_uri')).toBe(REDIRECT);
    expect(body.get('client_id')).toBe('google-client');
    expect(body.get('client_secret')).toBe('google-secret');
    expect(JSON.stringify(identity)).not.toContain('token');
  });

  for (const [status, expected] of [
    [400, 'INVALID_CREDENTIAL'],
    [429, 'UPSTREAM_UNAVAILABLE'],
    [500, 'UPSTREAM_UNAVAILABLE'],
  ] as const) {
    test(`classifies token endpoint HTTP ${status}`, async () => {
      const client = createGoogleOidcClient({
        clientId: 'google-client',
        clientSecret: 'google-secret',
        allowedRedirectUris: [REDIRECT],
        fetch: async () => new Response(null, { status }),
        idTokenVerifier: async () => VALID_CLAIMS,
      });
      expect(await codeOf(() => exchange(client))).toBe(expected);
    });
  }

  test('classifies a token endpoint network failure as upstream unavailable', async () => {
    const client = createGoogleOidcClient({
      clientId: 'google-client',
      clientSecret: 'google-secret',
      allowedRedirectUris: [REDIRECT],
      fetch: async () => Promise.reject(new Error('network down')),
      idTokenVerifier: async () => VALID_CLAIMS,
    });
    expect(await codeOf(() => exchange(client))).toBe('UPSTREAM_UNAVAILABLE');
  });

  test('refuses every required claim independently', async () => {
    const invalid: GoogleOidcClaims[] = [
      { ...VALID_CLAIMS, sub: undefined },
      { ...VALID_CLAIMS, email: undefined },
      { ...VALID_CLAIMS, email: 'not-an-email' },
      { ...VALID_CLAIMS, emailVerified: false },
      { ...VALID_CLAIMS, nonce: undefined },
      { ...VALID_CLAIMS, nonce: 'wrong-nonce' },
    ];
    for (const claims of invalid) {
      const { client } = oidc({ verify: async () => claims });
      expect(await codeOf(() => exchange(client))).toBe('INVALID_CREDENTIAL');
    }
  });

  for (const failure of ['bad signature', 'wrong issuer', 'wrong audience', 'expired token']) {
    test(`maps ${failure} to a safe invalid-credential error`, async () => {
      const { client } = oidc({ verify: async () => Promise.reject(new Error(failure)) });
      const error = await capturedError(() => exchange(client));
      expect(error.code).toBe('INVALID_CREDENTIAL');
      expect(error.message).not.toContain(failure);
    });
  }

  test('refuses a token response without an ID token', async () => {
    const { client } = oidc({ exchange: async () => ({ idToken: '' }) });
    expect(await codeOf(() => exchange(client))).toBe('INVALID_CREDENTIAL');
  });

  test('distinguishes upstream failures and never includes credentials in the error', async () => {
    const secrets = [
      'authorization-code',
      'pkce-verifier',
      'expected-nonce',
      'google-secret',
      'signed-id-token',
      'person@example.com',
    ];
    const { client } = oidc({
      exchange: async () => {
        throw new Error(`upstream leaked ${secrets.join(' ')}`);
      },
    });
    const error = await capturedError(() => exchange(client));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    const publicText = `${error.name} ${error.message} ${error.code} ${JSON.stringify(error)} ${inspect(error)}`;
    for (const secret of secrets) expect(publicText).not.toContain(secret);
  });

  test('does not write credentials or provider failures to console logs', async () => {
    const secrets = [
      'authorization-code',
      'pkce-verifier',
      'expected-nonce',
      'google-secret',
      'signed-id-token',
      'access-token',
      'refresh-token',
      'person@example.com',
    ];
    const captured: unknown[][] = [];
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((method) =>
      spyOn(console, method).mockImplementation((...values: unknown[]) => {
        captured.push(values);
      }),
    );
    try {
      const { client } = oidc({
        exchange: async () => {
          throw new Error(`provider response ${secrets.join(' ')}`);
        },
      });
      await capturedError(() => exchange(client));
    } finally {
      for (const spy of spies) spy.mockRestore();
      mock.restore();
    }
    const logged = inspect(captured);
    expect(captured).toHaveLength(0);
    for (const secret of secrets) expect(logged).not.toContain(secret);
  });

  test('aborts a token exchange at the configured deadline', async () => {
    const { client } = oidc({
      timeoutMs: 5,
      exchange: () => new Promise(() => undefined),
    });
    expect(await codeOf(() => exchange(client))).toBe('UPSTREAM_UNAVAILABLE');
  });
});
