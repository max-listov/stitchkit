/**
 * A `defineContract` bound to an application's scope vocabulary — so every
 * contract MUST declare a `scope`, typed to that union.
 *
 * Plain `defineContract` defaults a missing `scope` to `'public'` (fail-open):
 * forget it and the endpoint is public. A project that gates everything writes
 * a thin wrapper to make `scope` required and typed — the same 30-line wrapper
 * in every repo. `createContractFactory` is that wrapper, once:
 *
 * ```ts
 * // app: one line
 * const { defineContract } = createContractFactory<'public' | 'user' | 'admin'>();
 *
 * // scope is now REQUIRED and checked against the union — a typo or a missing
 * // scope is a compile error, not a silent public endpoint.
 * export const users = defineContract({ prefix: 'users', scope: 'user' }, { … });
 * ```
 *
 * The scope vocabulary comes from the app; the core stays domain-free (ADR 0002).
 * The returned contracts are ordinary `ContractDef`s — `implement`, `createClient`
 * and the tool mounts treat them exactly as before.
 */

import type { ContractDef, EndpointDef } from './define';
import { defineContract } from './define';

/** A `defineContract` whose `scope` is required and typed to `TScope`. */
export type ScopedDefineContract<TScope extends string> = <
  const T extends Record<string, EndpointDef>,
>(
  meta: { prefix: string; scope: TScope },
  endpoints: T,
) => ContractDef<T, TScope>;

/**
 * Build a `defineContract` that requires a `scope` from the application's own
 * union. Call once per app and re-export the returned `defineContract`.
 */
export function createContractFactory<TScope extends string>(): {
  defineContract: ScopedDefineContract<TScope>;
} {
  return {
    defineContract: (meta, endpoints) => {
      // Run the real `defineContract` for its validation (duplicate toolName,
      // empty desc), then return with the app's scope typed — its overloads
      // would otherwise resolve to the default `'public'` scope. No cast: the
      // result is rebuilt from the validated endpoints + the given scope.
      const validated = defineContract({ prefix: meta.prefix }, endpoints);
      return {
        endpoints: validated.endpoints,
        meta: { prefix: meta.prefix, scope: meta.scope },
      };
    },
  };
}
