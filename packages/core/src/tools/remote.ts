import { createClient } from '../browser/client';
import { ApiError, type HttpClient } from '../browser/http';
import type { ContractDef, EndpointDef } from '../contract/define';
import { AppError } from '../contract/errors';
import type { RuntimeContext } from '../contract/runtime-context';
import { isRecord } from '../internal/typed';
import { contractMethodFields } from '../server/contract-method';
import type { MethodDef, ServiceDef } from '../server/types';

/** A contract's typed client, viewed as a flat string-keyed call map. */
type RemoteCalls = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

/** Flatten a runtime context's `params` + `input` into one argument object. */
function toArgs(ctx: RuntimeContext): Record<string, unknown> {
  const { params, input } = ctx;
  return {
    ...(isRecord(params) ? params : {}),
    ...(isRecord(input) ? input : {}),
  };
}

export interface ImplementRemoteOptions {
  /**
   * Rewrite a call's arguments before they are forwarded to the remote API.
   * Receives the endpoint key and the merged args, returns the args to send —
   * e.g. to upload a local file referenced in the args and swap in its URL.
   */
  transformArgs?: (
    endpointKey: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Bind a contract to a remote HTTP client, producing a `ServiceDef` whose every
 * handler forwards the call to the remote API. The transport twin of
 * `implement`: instead of local business logic, each endpoint proxies to a
 * deployed server.
 *
 * Used to build a thin local MCP / agent server that re-exposes a remote API —
 * `buildMcpServer({ services: contracts.map((c) => implementRemote(c, http)) })`.
 */
export function implementRemote<T extends Record<string, EndpointDef>>(
  contract: ContractDef<T, string>,
  http: HttpClient,
  options?: ImplementRemoteOptions,
): ServiceDef {
  // `createClient` exposes one typed method per endpoint; this generic
  // forwarder indexes them by the contract's own string keys. The typed
  // surface is for callers — the single boundary here mirrors the identical
  // cast `createClient` itself crosses when it assembles the client.
  const client = createClient(contract, http) as unknown as RemoteCalls;
  const groupScope = contract.meta.scope ?? 'public';
  const methods: Record<string, MethodDef<unknown, unknown, unknown>> = {};

  for (const [key, endpoint] of Object.entries(contract.endpoints)) {
    methods[key] = {
      ...contractMethodFields(contract, key, endpoint),
      // The proxy answers a streaming endpoint as it always has — as a plain
      // forwarded call — rather than taking on the stream framing here.
      stream: undefined,
      // Elicitation rounds are asked and answered here, but the forwarded call
      // carries only `params` and `input`: the answers would never reach the
      // origin. A proxied tool therefore asks nothing — the origin's own MCP
      // surface is where its questions are asked.
      mcp: undefined,
      handler: async (ctx: RuntimeContext) => {
        // A raw endpoint proxies like any other: `createClient` asks for
        // `responseType: 'response'`, so the remote `Response` — bytes, status
        // and headers — is forwarded verbatim. Request headers are NOT relayed,
        // so a `Range` on the proxy is not seen by the origin and the full body
        // comes back. → ADR 0038.
        const call = client[key];
        if (!call) {
          throw new Error(`implementRemote: endpoint "${key}" is not exposed over HTTP`);
        }
        const args = toArgs(ctx);
        try {
          // Inside the try: a throwing transform hook (which may itself call
          // the remote API, e.g. to upload a referenced file) gets the same
          // error conversion as the forwarded call.
          const finalArgs = options?.transformArgs
            ? await options.transformArgs(key, args)
            : args;
          return await call(finalArgs);
        } catch (err) {
          // The typed client throws `ApiError` on a non-2xx remote response.
          // Translate it to the framework `AppError` so the real code / status /
          // hint survive — otherwise `normalizeError` flattens every remote
          // failure to `INTERNAL_SERVER_ERROR` (and logs a misleading "unhandled
          // error"). A remote 400 stays a clean `VALIDATION_ERROR`, a 403 a
          // `FORBIDDEN`, and so on, across every transport that mounts the proxy.
          if (ApiError.is(err)) {
            throw new AppError(
              err.code,
              err.message,
              err.status,
              isRecord(err.details) ? err.details : undefined,
              err.hint,
              err.traceId,
            );
          }
          throw err;
        }
      },
    };
  }

  return {
    name: contract.meta.prefix,
    prefix: contract.meta.prefix,
    scope: groupScope,
    methods,
  };
}
