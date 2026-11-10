/**
 * How an OpenAPI document says what a protected operation needs from its
 * caller: the standard `components.securitySchemes` and one `security`
 * requirement per operation.
 *
 * The document describes the host's auth policy; it never enforces it. The
 * runtime gate stays `createAuthHook` and its scope rules, so the mapping here
 * is keyed by the same scope names the contracts already declare — no second
 * copy of which endpoint is protected. The generator refuses to advertise a
 * protected operation it cannot describe: a scope missing from the mapping
 * would otherwise reach the spec as an open endpoint, and a generic client
 * would call it without a credential.
 */
import { z } from 'zod';

/** The key OpenAPI allows for a component, a security scheme's name included. */
const SchemeNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9._-]+$/, 'a scheme name may hold only letters, digits, ".", "_" and "-"');

const described = { description: z.string().min(1).optional() };

/** One way a request presents its credential — the OpenAPI Security Scheme Object. */
export const OpenApiSecuritySchemeSchema = z.union([
  z.strictObject({
    type: z.literal('http'),
    scheme: z.literal('bearer'),
    bearerFormat: z.string().min(1).optional(),
    ...described,
  }),
  z.strictObject({ type: z.literal('http'), scheme: z.literal('basic'), ...described }),
  z.strictObject({
    type: z.literal('apiKey'),
    in: z.enum(['header', 'query', 'cookie']),
    name: z.string().min(1),
    ...described,
  }),
]);

export type OpenApiSecurityScheme = z.infer<typeof OpenApiSecuritySchemeSchema>;

export const OpenApiSecuritySchema = z.strictObject({
  /** Named schemes, emitted as `components.securitySchemes`. */
  schemes: z.record(SchemeNameSchema, OpenApiSecuritySchemeSchema),
  /**
   * For every protected scope the spec advertises: the schemes that satisfy
   * it, any one of them. An empty list declares a scope whose auth rule is
   * `'public'`. The `'public'` scope itself is never listed — it is open.
   */
  scopes: z.record(z.string().min(1), z.array(SchemeNameSchema).readonly()),
  /** The scope an endpoint without its own is checked under — the auth hook's `defaultScope`. */
  defaultScope: z.string().min(1).optional(),
});

export type OpenApiSecurity = z.infer<typeof OpenApiSecuritySchema>;

/** The scope that needs no credential, as `createAuthHook` and the 401/403 responses read it. */
export const PUBLIC_SCOPE = 'public';

/** A configuration checked once, before any operation is emitted. */
export interface OpenApiSecurityPlan {
  readonly schemes: Readonly<Record<string, OpenApiSecurityScheme>>;
  /**
   * The operation's `security` value, or `undefined` for an open one.
   * `operation` names the endpoint in a refusal.
   */
  requirement(
    scope: string | undefined,
    operation: string,
  ): Array<Record<string, string[]>> | undefined;
}

function refuse(message: string): never {
  throw new Error(`[stitchkit] openapi: ${message}`);
}

/** Validate the host's security description, failing on the first contradiction. */
export function planOpenApiSecurity(input: OpenApiSecurity): OpenApiSecurityPlan {
  const parsed = OpenApiSecuritySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(`security.${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`);
  }
  const { schemes, scopes, defaultScope } = parsed.data;
  if (Object.hasOwn(scopes, PUBLIC_SCOPE)) {
    refuse(
      `security.scopes lists "${PUBLIC_SCOPE}", which is open by definition — remove it, or give the protected endpoints their own scope`,
    );
  }
  for (const [scope, names] of Object.entries(scopes)) {
    for (const name of names) {
      if (!Object.hasOwn(schemes, name)) {
        refuse(
          `security.scopes.${scope} names the scheme "${name}", which security.schemes does not declare`,
        );
      }
    }
  }

  return {
    schemes,
    requirement(scope, operation) {
      // The auth hook checks an endpoint without its own scope under
      // `defaultScope`, and lets it through when there is none.
      const effective = scope ?? defaultScope;
      if (effective === undefined || effective === PUBLIC_SCOPE) return undefined;
      const names = Object.hasOwn(scopes, effective) ? scopes[effective] : undefined;
      if (names === undefined) {
        refuse(
          `${operation} has scope "${effective}", but security.scopes names no scheme for it — a protected operation cannot be advertised as open`,
        );
      }
      return names.length === 0 ? undefined : names.map((name) => ({ [name]: [] }));
    },
  };
}
