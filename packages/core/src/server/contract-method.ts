import type { ContractDef, EndpointDef } from '../contract/define';
import { HTTP_ONLY_EXPOSURE, isHttpOnlyEndpoint } from '../contract/endpoint-capabilities';
import { AppError, isStitchErrorCode } from '../contract/errors';
import { describeRefusals } from '../contract/operation-refusals';
import { mergeMeta, type RuntimeContext } from '../contract/runtime-context';
import { resolveRouteParamsSchema } from '../internal/route-pattern';
import type { MethodDef } from './types';

/** Everything a `MethodDef` takes from its contract endpoint — all but how it runs. */
export type ContractMethodFields = Omit<MethodDef, 'handler' | 'multipartReceivers'>;

/**
 * One contract endpoint → the declared half of its `MethodDef`, shared by
 * `implement` and `implementRemote`.
 *
 * It was two hand-written copies, and they had already drifted: the remote one
 * left a streaming endpoint with the default tool exposure. A field added to an
 * endpoint now reaches both unless the proxy overrides it — and it overrides
 * only what a forwarded call cannot honour, each with its reason beside it.
 */
export function contractMethodFields(
  contract: ContractDef,
  key: string,
  endpoint: EndpointDef,
): ContractMethodFields {
  const groupScope = contract.meta.scope ?? 'public';
  return {
    method: endpoint.method,
    path: endpoint.path,
    desc: endpoint.desc,
    // Stable (service, action) identity for hooks / audit (→ ADR 0022).
    serviceName: contract.meta.prefix,
    key,
    toolName: endpoint.tool?.name,
    // An HTTP-only endpoint's exposure is written out: with `expose` undefined
    // the default convention reads "MCP + AGENT on", so an exposure reader —
    // an audit script, a bring-your-own transport — would take a download for a
    // tool (ADR 0038). An authored exposure, even an empty one, is kept as is.
    expose: endpoint.expose ?? (isHttpOnlyEndpoint(endpoint) ? HTTP_ONLY_EXPOSURE : undefined),
    // Effective scope: per-endpoint override, else the contract group scope.
    // Always populated so `beforeHandle(ctx, endpoint)` can scope-gate from
    // `endpoint.scope` alone — no consumer ever re-resolves against a service.
    scope: endpoint.scope ?? groupScope,
    // Closed side-effect tag (`'read'` | `'write'`) — propagated onto
    // `OperationIdentity`/`MethodDef` for hooks, tool gates and read-only hints.
    effect: endpoint.effect,
    // The declared refusals, resolved for a reader without types; the handler is held to them.
    refuses: describeRefusals(endpoint.refuses),
    paramsSchema: resolveRouteParamsSchema(endpoint.path, endpoint.params),
    inputSchema: endpoint.input,
    outputSchema: endpoint.output,
    // The tool-surface answer; HTTP never reads it. → ADR 0196.
    toolView: endpoint.tool?.view,
    stream: 'stream' in endpoint ? endpoint.stream : undefined,
    multipart: endpoint.multipart,
    maxJsonBodyBytes: endpoint.maxJsonBodyBytes,
    timeout: endpoint.timeout,
    // Transport-neutral retry/replay hint — rides through untouched (→ ADR 0027).
    idempotent: endpoint.idempotent,
    // The authored `tool` group, flattened: a `MethodDef` is also built by
    // runtime tools, which are tools rather than endpoints and carry these
    // fields at the top level. → ADR 0196.
    ui: endpoint.tool?.ui,
    annotations: endpoint.tool?.annotations,
    mcp: endpoint.tool?.mcp,
    inputRecursionDepth: endpoint.tool?.inputRecursionDepth,
    inputNestingDepth: endpoint.tool?.inputNestingDepth,
    // Opaque app metadata — the contract-wide default shallow-merged with the
    // endpoint's, endpoint keys winning. Undefined on both sides stays
    // undefined: readers test `method.meta?.x`. → ADR 0021 / 0036.
    meta: mergeMeta(contract.meta.meta, endpoint.meta),
    // The handler owns the response — skip output validation, serialization
    // and every tool surface. → ADR 0038.
    rawResponse: endpoint.rawResponse,
    rawBody: endpoint.rawBody,
    safelistedBody: endpoint.safelistedBody,
    responseMeta: endpoint.responseMeta,
    contentType: 'contentType' in endpoint ? endpoint.contentType : undefined,
  };
}

/** A handler's call shape, as `MethodDef.handler` and a streaming multipart `execute` share it. */
type OperationHandler = (ctx: RuntimeContext) => unknown;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Hold a handler to the refusals its operation declared (`refuses`). An `AppError` whose code the
 * operation did not declare, and that is no framework code, becomes `INTERNAL_SERVER_ERROR` (500)
 * with a safe message and the original as `cause` — on every transport, including mid-stream —
 * as an output that breaks its schema does. An operation that declares nothing runs unchanged.
 * → ADR 0330
 */
export function withDeclaredRefusals<THandler extends OperationHandler>(
  endpoint: EndpointDef,
  label: string,
  handler: THandler,
): THandler | ((ctx: RuntimeContext) => Promise<unknown>) {
  const declared = endpoint.refuses;
  if (declared === undefined) return handler;
  const codes = new Set(declared.map((refusal) => refusal.code));
  const held = (error: unknown): unknown => {
    if (!(error instanceof AppError) || codes.has(error.code) || isStitchErrorCode(error.code))
      return error;
    const refused = new AppError('INTERNAL_SERVER_ERROR', {
      message: `Operation ${label} failed with a code it does not declare`,
      status: 500,
    });
    refused.cause = error;
    return refused;
  };
  async function* streamed(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
    try {
      yield* source;
    } catch (error) {
      throw held(error);
    }
  }
  return async (ctx: RuntimeContext) => {
    let result: unknown;
    try {
      result = await handler(ctx);
    } catch (error) {
      throw held(error);
    }
    return 'stream' in endpoint && isAsyncIterable(result) ? streamed(result) : result;
  };
}
