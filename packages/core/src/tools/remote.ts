import { ApiError } from '../browser/api-error';
import { createClient } from '../browser/client';
import { endpointHasArguments } from '../browser/client-arguments';
import type { HttpClient } from '../browser/http';
import type { ClientRequestOptions } from '../contract/client-types';
import type { ContractDef, EndpointDef } from '../contract/define';
import { AppError, STITCH_ERROR_STATUS } from '../contract/errors';
import type { RuntimeContext } from '../contract/runtime-context';
import { isRecord } from '../internal/typed';
import { contractMethodFields } from '../server/contract-method';
import type { MethodDef, ServiceDef } from '../server/types';

/** A contract's typed client, viewed as a flat string-keyed call map. */
type RemoteCalls = Record<
  string,
  {
    withOptions(
      args: Record<string, unknown>,
      options: ClientRequestOptions,
    ): Promise<unknown>;
    withOptions(options: ClientRequestOptions): Promise<unknown>;
  }
>;

function refuseCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new ApiError('REQUEST_ABORTED', {
    status: 0,
    message: 'Request was aborted',
    retryable: false,
    cause: signal.reason,
  });
}

/** Flatten a runtime context's `params` + `input` into one argument object. */
function toArgs(ctx: RuntimeContext): Record<string, unknown> {
  const { params, input } = ctx;
  return {
    ...(isRecord(params) ? params : {}),
    ...(isRecord(input) ? input : {}),
  };
}

/**
 * The `AppError` a remote failure becomes, in one rule: the status decides
 * retryability unless the error declares it. The origin's own envelope keeps its
 * code, status, details and hint. A failure without an envelope — an HTML 503
 * page, a rate-limiting proxy, a refused connection — is projected to a fixed
 * message and no details, because its body and message can carry upstream
 * content, URLs or credentials; it keeps the upstream status, or answers
 * `CONNECTION_REQUEST_FAILED` when no response arrived. The original `ApiError`
 * stays on `cause` for in-process observers.
 */
function projectRemoteError(err: ApiError): AppError {
  if (err.code === 'HTTP_ERROR' || err.code === 'UNKNOWN_ERROR') {
    const answered = err.status > 0;
    const projected = new AppError(answered ? 'HTTP_ERROR' : 'CONNECTION_REQUEST_FAILED', {
      message: answered ? 'Remote service answered with an error' : 'Remote request failed',
      status: answered ? err.status : STITCH_ERROR_STATUS.CONNECTION_REQUEST_FAILED,
      traceId: err.traceId,
    });
    projected.cause = err;
    return projected;
  }
  const cancelled = err.status === 0 && err.code === 'REQUEST_ABORTED';
  const timedOut = err.status === 0 && err.code === 'REQUEST_TIMEOUT';
  return new AppError(err.code, {
    message: err.message,
    status: cancelled ? 499 : timedOut ? 408 : err.status,
    details: isRecord(err.details) ? err.details : undefined,
    hint: err.hint,
    traceId: err.traceId,
    retryable: err.retryable,
  });
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
          refuseCancelled(ctx.signal);
          // Inside the try: a throwing transform hook (which may itself call
          // the remote API, e.g. to upload a referenced file) gets the same
          // error conversion as the forwarded call.
          const finalArgs = options?.transformArgs
            ? await options.transformArgs(key, args)
            : args;
          refuseCancelled(ctx.signal);
          const requestOptions = { signal: ctx.signal };
          return await (endpointHasArguments(endpoint)
            ? call.withOptions(finalArgs, requestOptions)
            : call.withOptions(requestOptions));
        } catch (err) {
          // The typed client throws `ApiError` on a non-2xx remote response.
          // Translate it to the framework `AppError` so the real code / status /
          // hint survive — otherwise `normalizeError` flattens every remote
          // failure to `INTERNAL_SERVER_ERROR` (and logs a misleading "unhandled
          // error"). A remote 400 stays a clean `VALIDATION_ERROR`, a 403 a
          // `FORBIDDEN`, and so on, across every transport that mounts the proxy.
          if (ApiError.is(err)) throw projectRemoteError(err);
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
