import { createClient } from '../browser/client';
import { ApiError, type HttpClient } from '../browser/http';
import {
  AppError,
  type ContractDef,
  type EndpointDef,
  type RuntimeContext,
} from '../contract';
import { isRecord } from '../internal/typed';
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
      method: endpoint.method,
      path: endpoint.path,
      desc: endpoint.desc,
      toolName: 'toolName' in endpoint ? endpoint.toolName : undefined,
      expose: endpoint.expose,
      ui: 'ui' in endpoint ? endpoint.ui : undefined,
      annotations: 'annotations' in endpoint ? endpoint.annotations : undefined,
      scope: endpoint.scope ?? groupScope,
      paramsSchema: endpoint.params,
      inputSchema: endpoint.input,
      outputSchema: endpoint.output,
      multipart: endpoint.multipart,
      handler: async (ctx: RuntimeContext) => {
        const call = client[key];
        if (!call) {
          throw new Error(`implementRemote: endpoint "${key}" is not exposed over HTTP`);
        }
        const args = toArgs(ctx);
        const finalArgs = options?.transformArgs
          ? await options.transformArgs(key, args)
          : args;
        try {
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
