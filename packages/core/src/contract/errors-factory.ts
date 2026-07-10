/**
 * Declare an application's domain error codes once — typed throwers for the
 * server, a typed code table for the client.
 *
 * Services throw `notFound()` / `badRequest()` (stitchkit codes) or a bare
 * `appError('X')` today, and the client can only match on the raw `message`
 * string (which burned a consumer: `[object Object]` where a string was
 * expected). `defineErrors` gives a project a small, typed vocabulary:
 *
 * ```ts
 * export const { errors, codes, isCode } = defineErrors({
 *   SESSION_NOT_FOUND: 404,
 *   QUOTA_EXCEEDED: 429,
 * });
 *
 * // server: a typed thrower, correct HTTP status baked in
 * throw errors.SESSION_NOT_FOUND('no such session');
 *
 * // client: match the code with autocomplete, never a magic string
 * if (err instanceof ApiError && err.code === codes.SESSION_NOT_FOUND) { … }
 * ```
 *
 * The code rides through unchanged in both the HTTP envelope
 * (`{ error: { code, message } }`) and the MCP tool result (`{ error: <code> }`),
 * so one vocabulary covers every transport. The core stays domain-free — the
 * codes are the app's (ADR 0002).
 */
import { mapObject } from '../internal/typed';
import { AppError } from './errors';

/** A typed thrower — throws an `AppError` with the declared code and status. */
export type ErrorThrower = (
  message?: string,
  details?: Record<string, unknown>,
  hint?: string,
) => never;

/** The handle `defineErrors` returns. `TDef` maps `CODE → HTTP status`. */
export interface DefinedErrors<TDef extends Record<string, number>> {
  /** One thrower per code — `errors.CODE(message?)` throws the matching `AppError`. */
  errors: { [K in keyof TDef]: ErrorThrower };
  /** The code literals — `codes.CODE === 'CODE'`, for client-side matching. */
  codes: { readonly [K in keyof TDef]: K };
  /** Type guard — is `code` one of this app's declared codes? */
  isCode: (code: string) => code is keyof TDef & string;
}

/** Declare a set of domain error codes (`{ CODE: httpStatus }`). */
export function defineErrors<const TDef extends Record<string, number>>(
  defs: TDef,
): DefinedErrors<TDef> {
  const errors = mapObject<TDef, { [K in keyof TDef]: ErrorThrower }>(
    defs,
    (code, status) => (message, details, hint) => {
      // `code` is a key of `TDef` (declared as string keys); `String` keeps
      // `AppError`'s `code: string` happy under the generic `keyof` widening.
      throw new AppError(String(code), message, status, details, hint);
    },
  );
  const codes = mapObject<TDef, { [K in keyof TDef]: K }>(defs, (code) => code);
  const known = new Set(Object.keys(defs));
  return {
    errors,
    codes,
    isCode: (code: string): code is keyof TDef & string => known.has(code),
  };
}
