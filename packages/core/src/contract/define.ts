import { type ZodType, z } from 'zod';
import { parseTrailingWildcard } from '../internal/route-pattern';
import { isUnsafeKey } from '../internal/safe-json';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const ALL_TRANSPORTS = ['HTTP', 'MCP', 'AGENT', 'CLI'] as const;
export type Transport = (typeof ALL_TRANSPORTS)[number];

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

interface EndpointDefBase {
  method: Exclude<HttpMethod, 'HEAD'>;
  /**
   * Route under the contract prefix. Named segments (`/:id`) are exposed through
   * `params`; a terminal named wildcard (`/*filePath`) additionally exposes the
   * slash-joined remainder under that name and matches an empty remainder.
   */
  path: string;
  desc: string;
  scope?: string;
  params?: ZodType<unknown>;
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

/**
 * MCP Apps UI metadata for a tool (SEP-1865). When set, the tool's MCP
 * registration carries `_meta.ui`, so a host renders the named `ui://` resource
 * as an interactive widget for this tool's results. The resource itself is
 * served separately (see `McpServerBuildConfig.resources`).
 */
export interface EndpointUiMeta {
  /** `ui://…` resource the host renders for this tool's results. */
  resourceUri: string;
  /** Who sees the tool — `'model'` (in the tool list) and/or `'app'` (widget-only). */
  visibility?: readonly ('model' | 'app')[];
}

/**
 * MCP `ToolAnnotations` — behavioural hints a host reads to group tools and pick
 * permission defaults (read-only auto-allow, destructive needs approval) and to
 * show a human label. Hints only — never a security boundary.
 */
export interface EndpointToolAnnotations {
  /** Human-friendly display name (e.g. "Explore Models" instead of `list_models`). */
  title?: string;
  /** Tool does not mutate state — hosts may auto-allow and group as read-only. */
  readOnlyHint?: boolean;
  /** Tool may perform destructive updates (ignored when `readOnlyHint` is true). */
  destructiveHint?: boolean;
  /** Repeated calls with the same args have no additional effect. */
  idempotentHint?: boolean;
  /** Tool interacts with an open/external world (not a closed set). */
  openWorldHint?: boolean;
}

/** One typed form elicitation required before an MCP tool handler may execute. */
export interface EndpointMcpInputRequired<
  TKey extends string = string,
  TSchema extends z.ZodObject = z.ZodObject,
> {
  /** Stable response key carried across MRTR rounds. */
  key: TKey;
  /** Human-facing prompt shown by the MCP host. */
  message: string;
  /** Flat primitive object schema accepted from the host. */
  schema: TSchema;
}

/** MCP-only execution policy attached to a contract or runtime tool. */
export interface EndpointMcpPolicy<
  TRequests extends readonly EndpointMcpInputRequired[] = readonly EndpointMcpInputRequired[],
> {
  /** Ordered elicitation rounds. Every key must be unique. */
  inputRequired: TRequests;
}

interface HttpOnlyEndpointDef extends EndpointDefBase {
  expose: readonly ['HTTP'];
  toolName?: never;
  rawResponse?: never;
  rawBody?: never;
  responseMeta?: never;
}

interface ToolEndpointDef extends EndpointDefBase {
  toolName?: string;
  expose?: readonly Transport[];
  /** MCP Apps widget for this tool's results (MCP transport only). */
  ui?: EndpointUiMeta;
  /** MCP behavioural hints (read-only / destructive / title) for hosts. */
  annotations?: EndpointToolAnnotations;
  /** Opt-in multi-round input gate; ignored by HTTP, Agent and CLI. */
  mcp?: EndpointMcpPolicy;
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
  toolName?: never;
  ui?: never;
  annotations?: never;
  expose?: readonly ['HTTP'];
  responseMeta?: never;
}

interface ResponseMetaEndpointDefBase extends EndpointDefBase {
  responseMeta: EndpointResponseMeta;
  rawResponse?: never;
  toolName?: never;
  ui?: never;
  annotations?: never;
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
  /** Never a tool, so a tool name would be dead metadata. */
  toolName?: never;
  /** MCP-only decoration; a raw endpoint never reaches MCP. */
  ui?: never;
  /** MCP-only decoration; a raw endpoint never reaches MCP. */
  annotations?: never;
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
  toolName?: never;
  ui?: never;
  annotations?: never;
  mcp?: never;
  expose?: readonly ['HTTP'];
}

/** An explicit HTTP HEAD operation. Headers/status are handler-owned; the body is always stripped. */
export interface HeadEndpointDef {
  method: 'HEAD';
  path: string;
  desc: string;
  scope?: string;
  params?: ZodType<unknown>;
  timeout?: number;
  idempotent?: boolean;
  meta?: Record<string, unknown>;
  rawResponse: true;
  input?: never;
  output?: never;
  multipart?: never;
  rawBody?: never;
  maxJsonBodyBytes?: never;
  toolName?: never;
  ui?: never;
  annotations?: never;
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
 * definition time on a duplicate `toolName`.
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
  const toolTransports = new Map<string, { key: string; transports: Set<Transport> }>();
  for (const [key, ep] of Object.entries(endpoints)) {
    const wildcard = parseTrailingWildcard(ep.path);
    if (wildcard) {
      if (!ep.params) {
        throw new Error(
          `Contract "${meta.prefix}": endpoint "${key}" wildcard "${wildcard.name}" requires a params schema field`,
        );
      }
      const paramsJson = z.toJSONSchema(ep.params, { io: 'input' });
      if (!paramsJson.properties || !(wildcard.name in paramsJson.properties)) {
        throw new Error(
          `Contract "${meta.prefix}": endpoint "${key}" params schema is missing wildcard field "${wildcard.name}"`,
        );
      }
    }
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
    if ('responseMeta' in ep) assertResponseMetaEndpoint(meta.prefix, key, ep);

    if (!('toolName' in ep) || !ep.toolName) continue;
    const transports = new Set(
      ep.expose
        ? ep.expose.filter((t) => t !== 'HTTP')
        : (['MCP', 'AGENT'] satisfies Transport[]),
    );
    // A `toolName` only means anything on a tool transport — setting one on an
    // HTTP-only endpoint is a contract mistake. The type does **not** catch it:
    // `expose: ['HTTP']` also satisfies `ToolEndpointDef`, whose members are all
    // optional, so the union admits the pair. This guard is the real check —
    // and it also covers a contract assembled at runtime, past the types.
    if (transports.size === 0) {
      throw new Error(
        `Contract "${meta.prefix}": endpoint "${key}" sets toolName "${ep.toolName}" but is not exposed on any tool transport (MCP / AGENT)`,
      );
    }

    const existing = toolTransports.get(ep.toolName);
    if (existing) {
      // Merge into the existing entry — a third endpoint reusing the toolName
      // must be checked against the union of every prior transport, not just
      // the most recent one.
      for (const t of transports) {
        if (existing.transports.has(t)) {
          throw new Error(
            `Contract "${meta.prefix}": duplicate toolName "${ep.toolName}" on transport "${t}" (endpoints: "${existing.key}" and "${key}")`,
          );
        }
        existing.transports.add(t);
      }
    } else {
      toolTransports.set(ep.toolName, { key, transports });
    }
  }

  return { meta, endpoints };
}

function assertPositiveLimit(where: string, name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${where} ${name} must be a positive safe integer, received ${value}`);
  }
}

/** Multipart is one declarative HTTP-only request boundary. */
function assertMultipartEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": multipart endpoint "${key}"`;
  if (ep.method !== 'POST' && ep.method !== 'PUT' && ep.method !== 'PATCH') {
    throw new Error(`${where} must use POST, PUT or PATCH`);
  }
  const multipart = ep.multipart;
  if (!multipart || typeof multipart !== 'object') {
    throw new Error(`${where} must declare a multipart descriptor`);
  }
  assertPositiveLimit(where, 'maxRequestBytes', multipart.maxRequestBytes);
  assertPositiveLimit(where, 'maxFieldBytes', multipart.maxFieldBytes);
  const entries = Object.entries(multipart.files);
  if (entries.length === 0) throw new Error(`${where} must declare at least one file field`);
  for (const [field, policy] of entries) {
    if (!field || isUnsafeKey(field))
      throw new Error(`${where} has an invalid file field name`);
    assertPositiveLimit(`${where} field "${field}"`, 'maxBytes', policy.maxBytes);
    assertPositiveLimit(`${where} field "${field}"`, 'maxFiles', policy.maxFiles);
    if (policy.multiple !== true && policy.maxFiles !== undefined) {
      throw new Error(`${where} field "${field}" may set maxFiles only with multiple: true`);
    }
    if (policy.contentTypes) {
      if (policy.contentTypes.length === 0) {
        throw new Error(`${where} field "${field}" contentTypes cannot be empty`);
      }
      for (const contentType of policy.contentTypes) {
        if (!/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/i.test(contentType)) {
          throw new Error(
            `${where} field "${field}" has invalid content type policy "${contentType}"`,
          );
        }
      }
    }
  }
}

/**
 * A raw endpoint hands the whole response to the handler, so everything that
 * only makes sense for a *tool* is meaningless on it. The type already forbids
 * each of these; this repeats the rule for a contract assembled at runtime —
 * and it fails loudly at definition time rather than shipping a tool that
 * serializes a `Response` into `{}`. → ADR 0038.
 */
function assertRawEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": raw endpoint "${key}"`;
  if (ep.output) throw new Error(`${where} cannot declare an output schema`);
  if ('toolName' in ep && ep.toolName) throw new Error(`${where} cannot set a toolName`);
  if ('ui' in ep && ep.ui) throw new Error(`${where} cannot set MCP ui metadata`);
  if ('annotations' in ep && ep.annotations) {
    throw new Error(`${where} cannot set MCP annotations`);
  }
  const nonHttp = (ep.expose ?? []).filter((t) => t !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}

function assertStreamingResponseEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": streaming endpoint "${key}"`;
  if (!('stream' in ep) || !ep.stream || typeof ep.stream !== 'object') {
    throw new Error(`${where} must declare a stream descriptor`);
  }
  if (!ep.stream.item || typeof ep.stream.item.parse !== 'function') {
    throw new Error(`${where} must declare an item schema`);
  }
  const runtimeFormat: unknown = Reflect.get(ep.stream, 'format');
  const runtimeFinalLine: unknown = Reflect.get(ep.stream, 'finalLine');
  if (ep.stream.framing === 'item' && runtimeFormat === 'sse') {
    throw new Error(`${where} item framing is supported only for ndjson`);
  }
  if (ep.stream.framing === 'item' && ep.stream.completion !== 'terminal') {
    throw new Error(`${where} item framing requires terminal completion`);
  }
  if (ep.stream.completion === 'terminal' && !ep.stream.terminal) {
    throw new Error(`${where} terminal completion requires a terminal schema`);
  }
  if (runtimeFinalLine === 'require-newline' && runtimeFormat === 'sse') {
    throw new Error(`${where} finalLine applies only to ndjson`);
  }
  assertPositiveLimit(where, 'maxFrameBytes', ep.stream.maxFrameBytes);
  assertPositiveLimit(where, 'lifetimeMs', ep.stream.lifetimeMs);
  assertPositiveLimit(where, 'heartbeatMs', ep.stream.heartbeatMs);
  if (
    ep.stream.idleTimeoutSeconds !== undefined &&
    (!Number.isSafeInteger(ep.stream.idleTimeoutSeconds) || ep.stream.idleTimeoutSeconds < 0)
  ) {
    throw new Error(`${where} idleTimeoutSeconds must be a non-negative safe integer`);
  }
  if (ep.output) throw new Error(`${where} cannot declare an output schema`);
  if (ep.rawResponse) throw new Error(`${where} cannot also be rawResponse`);
  if (ep.multipart) throw new Error(`${where} cannot be multipart`);
  if ('toolName' in ep && ep.toolName) throw new Error(`${where} cannot set a toolName`);
  const nonHttp = (ep.expose ?? []).filter((transport) => transport !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}

/** HEAD is an explicit, bodyless, HTTP-only raw-response operation. */
function assertHeadEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": HEAD endpoint "${key}"`;
  if (!ep.rawResponse) throw new Error(`${where} must declare rawResponse: true`);
  if (ep.input) throw new Error(`${where} cannot declare an input schema`);
  if (ep.multipart) throw new Error(`${where} cannot be multipart`);
  if (ep.rawBody) throw new Error(`${where} cannot retain a raw body`);
}

/** Raw JSON text exists only on a validated, body-bearing HTTP operation. */
function assertRawBodyEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": rawBody endpoint "${key}"`;
  if (!ep.input) throw new Error(`${where} must declare an input schema`);
  if (ep.multipart) throw new Error(`${where} cannot be multipart`);
  if (ep.method !== 'POST' && ep.method !== 'PUT' && ep.method !== 'PATCH') {
    throw new Error(`${where} must use POST, PUT or PATCH`);
  }
  if ('toolName' in ep && ep.toolName) throw new Error(`${where} cannot set a toolName`);
  if ('ui' in ep && ep.ui) throw new Error(`${where} cannot set MCP ui metadata`);
  if ('annotations' in ep && ep.annotations) {
    throw new Error(`${where} cannot set MCP annotations`);
  }
  const nonHttp = (ep.expose ?? []).filter((transport) => transport !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}

/** Typed response metadata is a static, HTTP-only addition to the data path. */
function assertResponseMetaEndpoint(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": responseMeta endpoint "${key}"`;
  if (!ep.responseMeta || typeof ep.responseMeta !== 'object') {
    throw new Error(`${where} must declare responseMeta as an object`);
  }
  const status = ep.responseMeta.status;
  if (
    status !== undefined &&
    (!Number.isSafeInteger(status) || status < 200 || status > 299)
  ) {
    throw new Error(`${where} status must be a successful 2xx integer, received ${status}`);
  }
  if (ep.output && (status === 204 || status === 205)) {
    throw new Error(`${where} cannot combine output with bodyless status ${status}`);
  }
  if (ep.rawResponse) throw new Error(`${where} cannot also be a rawResponse endpoint`);
  if ('toolName' in ep && ep.toolName) throw new Error(`${where} cannot set a toolName`);
  if ('ui' in ep && ep.ui) throw new Error(`${where} cannot set MCP ui metadata`);
  if ('annotations' in ep && ep.annotations) {
    throw new Error(`${where} cannot set MCP annotations`);
  }
  const nonHttp = (ep.expose ?? []).filter((transport) => transport !== 'HTTP');
  if (nonHttp.length > 0) {
    throw new Error(`${where} is HTTP-only — remove ${nonHttp.join(', ')} from expose`);
  }
}

// ─── Runtime Context (built by transport, loose types) ───

/**
 * Shallow-merge a contract-wide `meta` default with an endpoint's own — endpoint
 * keys win. Returns `undefined` when neither side declares anything, because
 * readers test `method.meta?.x` and an empty object would read as "declared".
 * One level deep by design: a deep merge invites "how do I unset an inherited
 * key", which has no answer without a sentinel. → ADR 0036.
 */
export function mergeMeta(
  contractMeta: Record<string, unknown> | undefined,
  endpointMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!contractMeta) return endpointMeta;
  // Copy even when there is nothing to merge: returning the contract's own object
  // would alias it across every endpoint AND across every later `implement` of the
  // same contract, so one hook mutating `endpoint.meta` would corrupt all of them.
  // Identity is then consistent — a `MethodDef` always owns its `meta`.
  if (!endpointMeta) return { ...contractMeta };
  return { ...contractMeta, ...endpointMeta };
}

/** Self-reported MCP host identity. Attribution only — never an auth principal. */
export interface McpClientInfo {
  name: string;
  version: string;
}

/** Outcome of one opt-in MCP multi-round input attempt. */
export type McpRoundOutcome =
  | 'input_required'
  | 'declined'
  | 'cancelled'
  | 'invalid'
  | 'complete';

/**
 * Validated metadata for the active managed MCP tool call.
 *
 * `clientInfo` is supplied by the MCP host. It is useful for display and
 * operational attribution, but MUST NOT be used for authentication,
 * authorization, tenant selection or rate limiting.
 */
export interface McpCallContext {
  era: 'modern' | 'legacy';
  method: string;
  toolName: string;
  protocolVersion?: string;
  clientInfo?: McpClientInfo;
  outcome?: McpRoundOutcome;
  round?: number;
}

export interface RuntimeContext {
  params: unknown;
  input: unknown;
  files?: Record<string, unknown>;
  /** Original decoded JSON request text when the endpoint declares `rawBody: true`. */
  rawBody?: string;
  source: TransportSource;
  /**
   * The raw Web `Request`, its parsed `URL` and `Headers` — set on the HTTP
   * transport (and reachable in every lifecycle hook, including `onError` on a
   * validation failure). Absent on the non-HTTP transports (MCP / agent / CLI /
   * a bring-your-own lane), which carry no `Request`, so they are optional and a
   * reader narrows them. Web Fetch types only — the core stays Fetch-clean
   * (→ ADR 0013).
   */
  req?: Request;
  url?: URL;
  headers?: Headers;
  traceId?: string;
  spanId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** Transport cancellation for the active call (MCP and future cancellable lanes). */
  signal?: AbortSignal;
  /** Validated metadata for an MCP call; absent on every other transport. */
  mcp?: McpCallContext;
  [key: string]: unknown;
}

// ─── Handler Context (typed, inferred from endpoint) ─────

export interface HandlerContext<TParams = undefined, TInput = undefined> {
  params: TParams;
  input: TInput;
  files?: Record<string, unknown>;
  /** Original decoded JSON request text when the endpoint declares `rawBody: true`. */
  rawBody?: string;
  source: TransportSource;
  /** Raw Web `Request` / `URL` / `Headers` — set on the HTTP transport, absent
   *  on the tool transports (see {@link RuntimeContext}). */
  req?: Request;
  url?: URL;
  headers?: Headers;
  traceId?: string;
  spanId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** Validated metadata for an MCP call; absent on every other transport. */
  mcp?: McpCallContext;
  [key: string]: unknown;
}

// ─── Type Inference (for createClient) ──────────────────

type Prop<T, K extends string> = K extends keyof T ? T[K] : undefined;

// Endpoint args are what the CLIENT sends → the schema INPUT type (pre-parse).
// `.default()` / `.coerce` / `.transform()` make input and output differ: a
// `.default()` field is required in the parsed output but optional in the
// input. The typed client must use the input type, otherwise every caller is
// forced to pass server-defaulted fields. The handler's `ctx.input` keeps the
// output (post-parse) type — see `EndpointOutput`.
//
// Empty case is `unknown` (not `Record<string, never>`): `unknown & X = X`,
// whereas `Record<string, never>` carries an index signature that poisons
// every intersected field to `never`.
type InferInput<S> = S extends ZodType ? z.input<S> : unknown;

/**
 * A platform file descriptor accepted by the typed client's multipart methods
 * where a file is not a `Blob`. React Native / Expo represent a file as
 * `{ uri, name, type }` and their `FormData.append` streams it from disk by
 * `uri`; reading it into a `Blob` first (`fetch(uri).blob()`) would load the
 * whole media into memory. The web / Bun path still uses `Blob`.
 */
export interface FileDescriptor {
  /** Local file URI the platform streams from (e.g. `file:///…`). */
  uri: string;
  /** File name for the multipart part. */
  name: string;
  /** MIME type for the multipart part. */
  type: string;
}

/**
 * What a `multipart` endpoint's file field accepts on the typed client — a
 * `Blob` (web / Bun) or a platform {@link FileDescriptor} (React Native / Expo).
 * Exported so a consumer can type its own upload helpers without a cast.
 */
export type MultipartFile = Blob | FileDescriptor;

/** A single named file policy within a multipart request. */
export type MultipartFilePolicy =
  | {
      required?: boolean;
      multiple?: false;
      maxFiles?: never;
      maxBytes?: number;
      contentTypes?: readonly string[];
    }
  | {
      required?: boolean;
      multiple: true;
      maxFiles?: number;
      maxBytes?: number;
      contentTypes?: readonly string[];
    };

/** One source of truth for multipart cardinality, delivery and byte policy. */
export interface MultipartDescriptor {
  delivery?: 'buffer' | 'stream';
  maxRequestBytes?: number;
  maxFieldBytes?: number;
  files: Record<string, MultipartFilePolicy>;
}

type MultipartClientValue<P> = P extends { multiple: true } ? MultipartFile[] : MultipartFile;

type RequiredMultipartKeys<F> = {
  [K in keyof F]: F[K] extends { required: false } ? never : K;
}[keyof F];

type OptionalMultipartKeys<F> = {
  [K in keyof F]: F[K] extends { required: false } ? K : never;
}[keyof F];

type MultipartArgs<E> = E extends { multipart: { files: infer F } }
  ? { [K in RequiredMultipartKeys<F>]: MultipartClientValue<F[K]> } & {
      [K in OptionalMultipartKeys<F>]?: MultipartClientValue<F[K]>;
    }
  : unknown;

/** Buffered server-side file values inferred from a multipart descriptor. */
export type MultipartBufferedFiles<M> = M extends { files: infer F }
  ? {
      [K in keyof F]: F[K] extends { multiple: true }
        ? File[]
        : F[K] extends { required: false }
          ? File | undefined
          : File;
    }
  : never;

/** Public per-call options accepted by every typed HTTP endpoint's `withOptions` method. */
export interface ClientRequestOptions {
  signal?: AbortSignal;
}

type ClientEndpointWithArgs<Args, Output> = {
  (args: Args): Promise<Output>;
  withOptions(args: Args, options: ClientRequestOptions): Promise<Output>;
};

type ClientEndpointWithoutArgs<Output> = {
  (): Promise<Output>;
  withOptions(options: ClientRequestOptions): Promise<Output>;
};

type EndpointArgs<E> = InferInput<Prop<E, 'params'>> &
  InferInput<Prop<E, 'input'>> &
  MultipartArgs<E>;

/**
 * What the typed client resolves to. A `raw` endpoint hands back the untouched
 * `Response` — its body is bytes, and the headers carry what the caller needs
 * (`Content-Disposition`, `Content-Range`, `ETag`). → ADR 0038.
 */
type EndpointOutput<E> = E extends { rawResponse: true }
  ? Response
  : Prop<E, 'stream'> extends { item: ZodType<infer O> }
    ? AsyncIterableIterator<O>
    : Prop<E, 'output'> extends ZodType<infer O>
      ? O
      : undefined;

export type EndpointFn<E> = [keyof EndpointArgs<E>] extends [never]
  ? ClientEndpointWithoutArgs<EndpointOutput<E>>
  : ClientEndpointWithArgs<EndpointArgs<E>, EndpointOutput<E>>;

export type TypedClient<C extends Record<string, EndpointDef>> = {
  [K in keyof C]: EndpointFn<C[K]>;
};

type ExposesHttp<E> = E extends { expose: readonly Transport[] }
  ? 'HTTP' extends E['expose'][number]
    ? true
    : false
  : true;

// ─── Scoped client (keys a `pathPrefix` consumes become required args) ────────
//
// A per-tenant / resource-scoped client built with `createClient(c, http, {
// pathPrefix, stripPrefixKeys })` needs the consumed keys (e.g. `tenantId`) in
// every method's args even though they are not in the endpoint schemas. `Extra`
// is `{ [K in consumed]: string }`, or `unknown` for a plain client (so
// `EndpointArgs<E> & unknown = EndpointArgs<E>` — identical to `EndpointFn`).
type ArgsWith<E, Extra> = EndpointArgs<E> & Extra;

export type ScopedEndpointFn<E, Extra> = [keyof ArgsWith<E, Extra>] extends [never]
  ? ClientEndpointWithoutArgs<EndpointOutput<E>>
  : ClientEndpointWithArgs<ArgsWith<E, Extra>, EndpointOutput<E>>;

export type ScopedHttpClient<C extends Record<string, EndpointDef>, Extra> = {
  [K in keyof C as ExposesHttp<C[K]> extends true ? K : never]: ScopedEndpointFn<C[K], Extra>;
};

// A plain client is the scoped client with no extra keys (`unknown`), so
// `ScopedEndpointFn<E, unknown>` collapses to `EndpointFn<E>`.
export type TypedHttpClient<C extends Record<string, EndpointDef>> = ScopedHttpClient<
  C,
  unknown
>;

type IsUrlBuildable<E> = ExposesHttp<E>;

type EndpointUrlArgs<E> = InferInput<Prop<E, 'params'>> &
  (E extends { method: 'GET' | 'DELETE' } ? InferInput<Prop<E, 'input'>> : unknown);

type UrlArgsWith<E, Extra> = EndpointUrlArgs<E> & Extra;

export type ScopedUrlFn<E, Extra> = [keyof UrlArgsWith<E, Extra>] extends [never]
  ? () => string
  : (args: UrlArgsWith<E, Extra>) => string;

export type ScopedUrlBuilder<C extends Record<string, EndpointDef>, Extra> = {
  [K in keyof C as IsUrlBuildable<C[K]> extends true ? K : never]: ScopedUrlFn<C[K], Extra>;
};

export type TypedUrlBuilder<C extends Record<string, EndpointDef>> = ScopedUrlBuilder<
  C,
  unknown
>;
