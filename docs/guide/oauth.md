# Browser OAuth and Google OIDC

Stitchkit separates the browser's Authorization Code + PKCE transaction from the server's
provider credential verification. The application still owns navigation, users, account matching
and merge policy, persistence, sessions, roles, unlink policy and UI.

## Supported profile

The current Google adapter supports one explicit profile: **web OpenID Connect Authorization Code
with PKCE**. A browser performs a top-level redirect, an application backend exchanges the
one-time code, and Stitchkit returns a verified identity. It is the redirect-based sign-in path;
it is not a generic name for every Google identity or authorization mechanism.

Keep adjacent Google capabilities separate because their credentials, lifecycle and trust
boundaries differ:

| Capability | Credential/result | Stitchkit support |
| --- | --- | --- |
| Web OIDC Authorization Code + PKCE | verified user identity | `stitchkit/oauth` + `stitchkit/google` |
| Google Identity Services button, One Tap or FedCM | browser-delivered ID credential | not implemented |
| Incremental authorization for Drive, Calendar or other Google APIs | access/refresh tokens and granted scopes | not implemented |
| Installed Android, iOS or desktop application | platform client and system-browser callback | not implemented |
| Limited-input/device authorization | device/user codes and polling lifecycle | not implemented |
| Service account or workload identity | application identity, possibly domain-wide delegation | not implemented |

Do not add these as mode flags to `GoogleOidcClient`. Each future capability gets its own adapter
and result type, while the provider-neutral PKCE transaction can be reused where its protocol
actually applies. In particular, authentication establishes the person; authorization to Google
APIs is requested later, in product context, and owns refresh-token persistence and revocation.

## Browser transaction

`stitchkit/oauth` is browser-safe and provider-neutral. It creates independent 32-byte `state`,
`nonce` and PKCE verifier values, writes one versioned transaction to caller-provided storage and
returns the authorization URL without navigating:

```ts
import { createAuthorizationCodeClient, safeInternalReturnPath } from 'stitchkit/oauth'
import { z } from 'zod'

const oauth = createAuthorizationCodeClient({
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  clientId,
  redirectUri: `${window.location.origin}/auth/google/callback`,
  scopes: ['openid', 'email', 'profile'],
  storage: window.sessionStorage,
  storageKey: 'app:google:oauth',
  contextSchema: z.object({ mode: z.enum(['login', 'link']), returnTo: z.string() }),
  authorizationParameters: { prompt: 'select_account' },
})

const { authorizationUrl } = await oauth.begin({
  context: { mode: 'login', returnTo: '/account' },
})
window.location.assign(authorizationUrl)

// In the callback route. Reading is one-shot even when validation fails.
const pending = oauth.consume({ state: new URL(location.href).searchParams.get('state') ?? '' })
const returnTo = safeInternalReturnPath(pending.context.returnTo, '/')
```

Provider parameters cannot replace protocol-owned fields. `consume` removes the pending value
before parsing, version checking, context validation or state comparison, so a malformed callback
and a React Strict Mode replay cannot reuse it. Errors expose a stable
`AuthorizationCodeClientError.code` and never include transaction contents.

Token exchange, ID-token verification, credential persistence and application identity do not
belong to this browser entrypoint.

## Google server adapter

Install the optional peer only in an application that imports `stitchkit/google`:

```bash
bun add google-auth-library
```

```ts
import { createGoogleOidcClient } from 'stitchkit/google'

const google = createGoogleOidcClient({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  allowedRedirectUris: [env.GOOGLE_WEB_CALLBACK, env.GOOGLE_LOOPBACK_CALLBACK],
  timeoutMs: 10_000,
})

const identity = await google.exchangeAuthorizationCode({
  code,
  codeVerifier: pending.codeVerifier,
  redirectUri: pending.redirectUri,
  nonce: pending.nonce,
})
// { subject, email, name?, picture? }
```

The redirect must match the immutable allowlist exactly before any outbound call. The token
exchange is bounded by an abort deadline; `google-auth-library` verifies the ID-token signature,
issuer, audience and expiry. Stitchkit additionally requires `sub`, a valid verified email and an
exact nonce. Access, refresh and raw ID tokens never leave the adapter.

`GoogleOidcError.code` distinguishes `MISCONFIGURED`, `INVALID_CREDENTIAL` and
`UPSTREAM_UNAVAILABLE` with fixed safe messages. Endpoints compose their own rate limiter and then
map the verified identity into application-owned user/session policy. Offline access, Google API
scopes, database writes, user lookup or merging, session rotation, roles and UI remain outside the
adapter.
