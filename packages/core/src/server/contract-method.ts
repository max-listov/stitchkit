import type { ContractDef, EndpointDef } from '../contract/define';
import { mergeMeta } from '../contract/runtime-context';
import { resolveRouteParamsSchema } from '../internal/route-pattern';
import type { MethodDef } from './types';

const HTTP_ONLY = Object.freeze(['HTTP'] as const);

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
    // A raw endpoint's exposure is forced, not inherited: with `expose`
    // undefined the framework's own default convention reads "MCP + AGENT on",
    // so every pre-existing exposure reader — audit scripts, a bring-your-own
    // transport — would conclude a download is a tool. Making it explicit keeps
    // them correct without teaching them about `raw`. → ADR 0038.
    expose:
      endpoint.rawResponse ||
      endpoint.rawBody ||
      endpoint.responseMeta ||
      ('stream' in endpoint && endpoint.stream)
        ? HTTP_ONLY
        : endpoint.expose,
    // Effective scope: per-endpoint override, else the contract group scope.
    // Always populated so `beforeHandle(ctx, endpoint)` can scope-gate from
    // `endpoint.scope` alone — no consumer ever re-resolves against a service.
    scope: endpoint.scope ?? groupScope,
    paramsSchema: resolveRouteParamsSchema(endpoint.path, endpoint.params),
    inputSchema: endpoint.input,
    outputSchema: endpoint.output,
    // The tool-surface answer; HTTP never reads it. → ADR 0196.
    toolView: endpoint.tool?.view,
    stream: 'stream' in endpoint ? endpoint.stream : undefined,
    multipart: endpoint.multipart,
    maxJsonBodyBytes: endpoint.maxJsonBodyBytes,
    // Transport-neutral retry/replay hint — rides through untouched (→ ADR 0027).
    idempotent: endpoint.idempotent,
    // The authored `tool` group, flattened: a `MethodDef` is also built by
    // runtime tools, which are tools rather than endpoints and carry these
    // fields at the top level. → ADR 0196.
    ui: endpoint.tool?.ui,
    annotations: endpoint.tool?.annotations,
    mcp: endpoint.tool?.mcp,
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
