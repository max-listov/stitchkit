import type { ZodType } from 'zod';
import { resolveRouteParamsSchema } from '../internal/route-pattern';
import type { MultipartDescriptor } from './client-types';
import {
  assertHeadEndpoint,
  assertMultipartEndpoint,
  assertNoUngroupedToolOptions,
  assertRawBodyEndpoint,
  assertRawEndpoint,
  assertResponseMetaEndpoint,
  assertSafelistedBodyEndpoint,
  assertStreamingResponseEndpoint,
} from './define-validation';
import type { EndpointToolOptions } from './tool-options';
import { assertToolView } from './tool-view';

export type { PathParams } from '../internal/route-pattern';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const ALL_TRANSPORTS = ['HTTP', 'MCP', 'AGENT', 'CLI'] as const;
export type Transport = (typeof ALL_TRANSPORTS)[number];
/** The transports a model or a tool client reads — every transport except HTTP. */
export const TOOL_TRANSPORTS = ['MCP', 'AGENT', 'CLI'] as const satisfies readonly Transport[];
export type ToolTransport = (typeof TOOL_TRANSPORTS)[number];

/** Successful HTTP statuses that may be declared by a typed-data endpoint. */
export type HttpSuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

/** Successful statuses that permit a response body. */
export type BodyHttpSuccessStatus = Exclude<HttpSuccessStatus, 204 | 205>;

/** Static HTTP response metadata declared in a contract. */
export interface EndpointResponseMeta {
  status?: HttpSuccessStatus;
}

/** Per-request outbound metadata available only to a `responseMeta` handler. */
export interface ResponseMetadata {
  headers: Headers;
}

/** Whether the wire carries Stitchkit protocol envelopes or schema-owned items. */
export type ContractStreamFraming = 'envelope' | 'item';

/** What conclusively completes one contract-first stream operation. */
export type ContractStreamCompletion = 'stream-end' | 'terminal';

/** How an NDJSON reader treats a final JSON document without a newline. */
export type StreamFinalLinePolicy = 'allow' | 'require-newline';

interface EndpointStreamDescriptorBase<TItem extends ZodType> {
  item: TItem;
  /** Maximum encoded data-frame size. Default 256 KiB. */
  maxFrameBytes?: number;
  /** Optional total operation lifetime after response open. */
  lifetimeMs?: number;
  /** Default 5 seconds; keeps a healthy quiet feed observable to intermediaries. */
  heartbeatMs?: number;
  /** Default 0 (disabled). */
  idleTimeoutSeconds?: number;
}

type ContractStreamEncoding =
  | {
      /** Default `ndjson`. */
      format?: 'ndjson';
      /** Default `allow`, preserving permissive parser behaviour. */
      finalLine?: StreamFinalLinePolicy;
    }
  | {
      format: 'sse';
      finalLine?: never;
    };

type StreamEndCompletion = {
  /** Default `stream-end`: the envelope's explicit end frame. */
  completion?: 'stream-end';
  /** When present, normal stream-end completion requires at least one matching item. */
  terminal?: ZodType<unknown>;
};

type TerminalItemCompletion = {
  /** The matching terminal item completes the operation and releases I/O before delivery. */
  completion: 'terminal';
  terminal: ZodType<unknown>;
};

/** Wire framing, completion ownership and bounds for one contract-first response stream. */
export type EndpointStreamDescriptor<TItem extends ZodType = ZodType> =
  | (EndpointStreamDescriptorBase<TItem> &
      ContractStreamEncoding & {
        /** Default `envelope`: `data` / safe `error` / `end` protocol frames. */
        framing?: 'envelope';
      } & (StreamEndCompletion | TerminalItemCompletion))
  | (EndpointStreamDescriptorBase<TItem> & {
      /** Schema-owned NDJSON frames with no Stitchkit protocol envelope. */
      framing: 'item';
      format?: 'ndjson';
      finalLine?: StreamFinalLinePolicy;
      completion: 'terminal';
      terminal: ZodType<unknown>;
    });

/**
 * The transport tag on `ctx.source`. The four built-ins keep autocomplete, but
 * the union is **open** (`string & {}`) so a bring-your-own transport — e.g. a
 * raw-WebSocket lane that runs a contract through the app's own dispatch loop —
 * can tag its own calls (`source: 'local-ws'`). `source` is transport-only and
 * carries no framework behaviour (→ ADR 0002).
 */
export type TransportSource = 'http' | 'mcp' | 'agent' | 'cli' | (string & {});

/** What every endpoint declares, a HEAD operation included: where it lives and how it is described. */
interface EndpointRouteBase {
  /**
   * Route under the contract prefix. Named segments (`/:id`) are exposed through
   * `params`; a terminal named wildcard (`/*filePath`) additionally exposes the
   * slash-joined remainder under that name and matches an empty remainder.
   */
  path: string;
  desc: string;
  scope?: string;
  params?: ZodType<unknown>;
  /**
   * HTTP client timeout in ms for this endpoint. Use it for slow synchronous
   * endpoints (AI generation) that need more than the client default. A
   * property of the endpoint — declared once, the typed client applies it.
   */
  timeout?: number;
  /**
   * Whether calling this operation twice with the same input is safe (the
   * second call yields the same result and no extra side effect) — a
   * transport-neutral property of the operation, like HTTP `PUT`/`DELETE`.
   *
   * The core attaches **no** behaviour to it (it stays generic — ADR 0002): it
   * rides through to `MethodDef.idempotent`, where a transport that can retry
   * reads it. A reliable bring-your-own-transport lane (e.g. a raw-WebSocket
   * client) replays an `idempotent` call after a reconnect — that is the
   * durability guarantee — while a non-idempotent one is rejected rather than
   * re-sent (a duplicate would be a second side effect). Unset means "unknown" —
   * a careful transport treats it as non-idempotent.
   */
  idempotent?: boolean;
  /**
   * Opaque, app-defined per-endpoint metadata. The core attaches **no** meaning
   * to it (like `scope`, it is a free escape-hatch — ADR 0002/0021): it rides
   * through to `MethodDef.meta`, readable in lifecycle hooks
   * (`beforeHandle`/`afterHandle`/`onError`) and on tool mounts. Use it for
   * app concerns the generic core does not model — a feature gate, a rate tier,
   * a cache hint, a doc/owner tag. The consumer narrows the type when reading.
   * Never surfaced in the OpenAPI document (app-private, not the HTTP contract).
   *
   * Declare its type as a `type` / inline literal / `satisfies` — **not an
   * `interface`** (an interface has no implicit index signature, so it is not
   * assignable to `Record<string, unknown>`).
   */
  meta?: Record<string, unknown>;
}

interface EndpointDefBase extends EndpointRouteBase {
  method: Exclude<HttpMethod, 'HEAD'>;
  input?: ZodType<unknown>;
  output?: ZodType<unknown>;
  multipart?: MultipartDescriptor;
  /**
   * Per-route ceiling in bytes for a JSON request body. Overrides the server's
   * `maxJsonBodyBytes`; without either, JSON body size is unchanged/unbounded.
   * Enforced while streaming, before the complete body is buffered.
   */
  maxJsonBodyBytes?: number;
  /**
   * Accept the JSON body under `text/plain` as well as `application/json` — the
   * CORS-safelisted media type a page can send **without a preflight**, which
   * is the only way a document that is being unloaded can deliver a body to
   * another origin (`navigator.sendBeacon(url, string)`). The body is still
   * parsed as JSON, validated against `input` and bounded by `maxJsonBodyBytes`.
   *
   * The cost is the reason the default refuses `text/plain`: a simple request
   * is sent with cookies from any site, before CORS can say no. So a
   * safelisted body is accepted **only** from an `Origin` on the server's
   * explicit `cors.origin` allow-list — never `'*'`, never `null`, never
   * absent — and the identity such a body carries is readable in
   * `beforeHandle` or the handler, not in `authorize`, which runs before the
   * body is read. `POST` only: the other body methods always preflight.
   * Transport-neutral — the flag changes HTTP parsing, not `expose`. → ADR 0165.
   */
  safelistedBody?: true;
}

interface HttpOnlyEndpointDef extends EndpointDefBase {
  expose: readonly ['HTTP'];
  tool?: never;
  rawResponse?: never;
  rawBody?: never;
  responseMeta?: never;
}

/** The endpoint shape that may reach a tool transport. */
export interface ToolEndpointDef extends EndpointDefBase {
  expose?: readonly Transport[];
  /** What the tool surface reads that HTTP does not. */
  tool?: EndpointToolOptions;
  rawResponse?: never;
  rawBody?: never;
  responseMeta?: never;
}

/** A validated JSON endpoint that also retains the original decoded body text. */
interface RawBodyEndpointDef extends EndpointDefBase {
  method: 'POST' | 'PUT' | 'PATCH';
  input: ZodType<unknown>;
  rawBody: true;
  multipart?: never;
  rawResponse?: never;
  tool?: never;
  expose?: readonly ['HTTP'];
  responseMeta?: never;
}

interface ResponseMetaEndpointDefBase extends EndpointDefBase {
  responseMeta: EndpointResponseMeta;
  rawResponse?: never;
  tool?: never;
  contentType?: never;
  expose?: readonly ['HTTP'];
}

/** HTTP-only typed data with a declared body-capable success status. */
interface ResponseMetaDataEndpointDef extends ResponseMetaEndpointDefBase {
  output: ZodType<unknown>;
  responseMeta: { status?: BodyHttpSuccessStatus };
  rawBody?: never;
}

/** HTTP-only empty response; bodyless 204/205 statuses are legal here. */
interface ResponseMetaEmptyEndpointDef extends ResponseMetaEndpointDefBase {
  output?: never;
  responseMeta: EndpointResponseMeta;
  rawBody?: never;
}

/** Response metadata composed with validated raw JSON retention. */
interface ResponseMetaRawBodyDataEndpointDef extends ResponseMetaEndpointDefBase {
  method: 'POST' | 'PUT' | 'PATCH';
  input: ZodType<unknown>;
  output: ZodType<unknown>;
  responseMeta: { status?: BodyHttpSuccessStatus };
  rawBody: true;
  multipart?: never;
}

/** Empty response metadata composed with validated raw JSON retention. */
interface ResponseMetaRawBodyEmptyEndpointDef extends ResponseMetaEndpointDefBase {
  method: 'POST' | 'PUT' | 'PATCH';
  input: ZodType<unknown>;
  output?: never;
  responseMeta: EndpointResponseMeta;
  rawBody: true;
  multipart?: never;
}

/**
 * An endpoint whose handler returns the **`Response` itself** instead of data —
 * a file download, a PDF, an SSE stream, a redirect. → ADR 0038.
 *
 * ```ts
 * pdf: {
 *   method: 'GET', path: '/:id/pdf', desc: 'Download the offer as a PDF',
 *   params: z.object({ id: z.uuid() }),
 *   rawResponse: true, contentType: 'application/pdf',
 * }
 * ```
 *
 * Only the **response** is raw — hence the name, and the difference from
 * `rawRoutes`, which sit outside the contract entirely. Here the request half is
 * unchanged: `params` / `input` / `multipart` parse and validate exactly as
 * elsewhere, and `beforeHandle` runs, so the auth gate applies with no guard in
 * the handler. What is handed over is the response, so there is no `output` to
 * validate, nothing to serialize into a tool result, and the endpoint is
 * **HTTP-only**: never an MCP tool, an agent tool or a CLI command.
 * `afterHandle` is skipped (it transforms data; there is none).
 */
interface RawResponseEndpointDef extends EndpointDefBase {
  /**
   * Marks the response as raw. Must be the literal `true` — it is the
   * discriminant of the union, so `rawResponse: false` is not a way to say
   * "normal".
   */
  rawResponse: true;
  /** Retain the validated JSON request's original decoded body text. */
  rawBody?: true;
  /**
   * The `Content-Type` this endpoint answers with, for documentation only —
   * the handler still sets the real header (`serveFile` detects it from the
   * path). Drives the OpenAPI response media type; without it the endpoint
   * documents as `application/octet-stream`.
   */
  contentType?: string;
  /** There is no output schema — the handler owns the whole response. */
  output?: never;
  /** Never a tool, so tool options would be dead metadata. */
  tool?: never;
  /** Redundant but allowed, so `expose: ['HTTP']` survives a migration. */
  expose?: readonly ['HTTP'];
  responseMeta?: never;
}

/** A validated HTTP-only stream whose client yields schema-derived items. */
interface StreamingResponseEndpointDef extends EndpointDefBase {
  stream: EndpointStreamDescriptor;
  output?: never;
  rawResponse?: never;
  rawBody?: never;
  responseMeta?: never;
  multipart?: never;
  tool?: never;
  expose?: readonly ['HTTP'];
}

/** An explicit HTTP HEAD operation. Headers/status are handler-owned; the body is always stripped. */
export interface HeadEndpointDef extends EndpointRouteBase {
  method: 'HEAD';
  rawResponse: true;
  input?: never;
  output?: never;
  multipart?: never;
  rawBody?: never;
  maxJsonBodyBytes?: never;
  safelistedBody?: never;
  tool?: never;
  expose?: readonly ['HTTP'];
  responseMeta?: never;
  contentType?: string;
}

export type EndpointDef =
  | HttpOnlyEndpointDef
  | ToolEndpointDef
  | RawBodyEndpointDef
  | ResponseMetaDataEndpointDef
  | ResponseMetaEmptyEndpointDef
  | ResponseMetaRawBodyDataEndpointDef
  | ResponseMetaRawBodyEmptyEndpointDef
  | RawResponseEndpointDef
  | StreamingResponseEndpointDef
  | HeadEndpointDef;

export interface ContractMeta<TScope extends string = string> {
  prefix: string;
  scope?: TScope;
  /**
   * Contract-wide default for every endpoint's opaque `meta` (→ ADR 0021).
   * Endpoints **shallow-merge** over it, key by key — so a contract-wide
   * `{ public: true }` survives an endpoint that adds `{ rateTier: 2 }`. One
   * level only, no deep merge. An explicit `key: undefined` on the endpoint is
   * the opt-out: it shadows the contract's value, so `meta?.key` readers see
   * nothing — test values, not key membership. → ADR 0036.
   *
   * `expose` deliberately has no equivalent — see ADR 0036 for why, and pin
   * `listToolNames` in a snapshot to catch an endpoint that forgot it.
   */
  meta?: Record<string, unknown>;
}

export interface ContractDef<
  T extends Record<string, EndpointDef> = Record<string, EndpointDef>,
  TScope extends string = string,
> {
  meta: ContractMeta<TScope>;
  endpoints: T;
}

/**
 * Declare an API contract — a `prefix` plus a map of endpoints (method, path,
 * Zod `params` / `input` / `output`, `scope`, `expose`). One contract drives
 * the HTTP routes, the MCP and agent tools, and the typed client. Throws at
 * definition time on a duplicate `tool.name`.
 */
export function defineContract<const T extends Record<string, EndpointDef>>(
  meta: { prefix: string; meta?: Record<string, unknown> },
  endpoints: T,
): ContractDef<T, 'public'>;
export function defineContract<
  TScope extends string,
  const T extends Record<string, EndpointDef>,
>(
  meta: { prefix: string; scope: TScope; meta?: Record<string, unknown> },
  endpoints: T,
): ContractDef<T, TScope>;
export function defineContract(
  meta: ContractMeta,
  endpoints: Record<string, EndpointDef>,
): ContractDef {
  const materializedEndpoints: Record<string, EndpointDef> = {};
  for (const [key, endpoint] of Object.entries(endpoints)) {
    const params = resolveRouteParamsSchema(endpoint.path, endpoint.params);
    materializedEndpoints[key] =
      params === endpoint.params ? endpoint : { ...endpoint, params };
  }

  const toolTransports = new Map<string, { key: string; transports: Set<Transport> }>();
  for (const [key, ep] of Object.entries(materializedEndpoints)) {
    // `desc` is the description a model reads to decide whether to call the
    // tool — an empty one passes the type check but ships an unusable tool.
    if (ep.desc.trim() === '') {
      throw new Error(`Contract "${meta.prefix}": endpoint "${key}" has an empty desc`);
    }

    if (
      ep.maxJsonBodyBytes !== undefined &&
      (!Number.isSafeInteger(ep.maxJsonBodyBytes) || ep.maxJsonBodyBytes <= 0)
    ) {
      throw new Error(
        `Contract "${meta.prefix}": endpoint "${key}" maxJsonBodyBytes must be a positive safe integer, received ${ep.maxJsonBodyBytes}`,
      );
    }

    if (ep.multipart) assertMultipartEndpoint(meta.prefix, key, ep);

    if (ep.rawResponse) assertRawEndpoint(meta.prefix, key, ep);
    if ('stream' in ep) assertStreamingResponseEndpoint(meta.prefix, key, ep);
    if (ep.method === 'HEAD') assertHeadEndpoint(meta.prefix, key, ep);
    if (ep.rawBody) assertRawBodyEndpoint(meta.prefix, key, ep);
    if (ep.safelistedBody) assertSafelistedBodyEndpoint(meta.prefix, key, ep);
    if ('responseMeta' in ep) assertResponseMetaEndpoint(meta.prefix, key, ep);
    assertNoUngroupedToolOptions(meta.prefix, key, ep);
    const tool = 'tool' in ep ? ep.tool : undefined;
    if (tool === undefined) continue;
    if (typeof tool !== 'object' || tool === null) {
      throw new Error(`Contract "${meta.prefix}": endpoint "${key}" tool must be an object`);
    }
    const transports = new Set(
      ep.expose
        ? ep.expose.filter((t) => t !== 'HTTP')
        : (['MCP', 'AGENT'] satisfies Transport[]),
    );
    // Tool options only mean anything on a tool transport — setting them on an
    // HTTP-only endpoint is a contract mistake. The type does **not** catch
    // every case: a contract factory with `toolExposure: 'explicit'` makes an
    // omitted `expose` HTTP-only after the types have spoken, and a contract
    // assembled at runtime never met them. This guard is the real check.
    if (transports.size === 0) {
      throw new Error(
        `Contract "${meta.prefix}": endpoint "${key}" sets tool options but is not exposed on any tool transport (${TOOL_TRANSPORTS.join(' / ')}) — a contract factory with toolExposure 'explicit' makes an omitted expose HTTP-only`,
      );
    }
    if (tool.view !== undefined) assertToolView(meta.prefix, key, ep);

    if (!tool.name) continue;
    const existing = toolTransports.get(tool.name);
    if (existing) {
      // Merge into the existing entry — a third endpoint reusing the toolName
      // must be checked against the union of every prior transport, not just
      // the most recent one.
      for (const t of transports) {
        if (existing.transports.has(t)) {
          throw new Error(
            `Contract "${meta.prefix}": duplicate tool name "${tool.name}" on transport "${t}" (endpoints: "${existing.key}" and "${key}")`,
          );
        }
        existing.transports.add(t);
      }
    } else {
      toolTransports.set(tool.name, { key, transports });
    }
  }

  return { meta, endpoints: materializedEndpoints };
}
