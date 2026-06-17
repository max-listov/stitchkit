import type { ZodType, z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const ALL_TRANSPORTS = ['HTTP', 'MCP', 'AGENT', 'CLI'] as const;
export type Transport = (typeof ALL_TRANSPORTS)[number];

/**
 * The transport tag on `ctx.source`. The four built-ins keep autocomplete, but
 * the union is **open** (`string & {}`) so a bring-your-own transport — e.g. a
 * raw-WebSocket lane that runs a contract through the app's own dispatch loop —
 * can tag its own calls (`source: 'local-ws'`). `source` is transport-only and
 * carries no framework behaviour (→ ADR 0002).
 */
export type TransportSource = 'http' | 'mcp' | 'agent' | 'cli' | (string & {});

interface EndpointDefBase {
  method: HttpMethod;
  path: string;
  desc: string;
  scope?: string;
  params?: ZodType<unknown>;
  input?: ZodType<unknown>;
  output?: ZodType<unknown>;
  multipart?: string;
  /**
   * Per-route upload ceiling in bytes for a `multipart` endpoint. Overrides the
   * server's `maxUploadBytes` default; without either, the 25 MB framework
   * default applies. Lets an avatar (5 MB) and a video (200 MB) declare their
   * own caps. Ignored on non-multipart endpoints.
   */
  maxUploadBytes?: number;
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

interface HttpOnlyEndpointDef extends EndpointDefBase {
  expose: readonly ['HTTP'];
  toolName?: never;
}

interface ToolEndpointDef extends EndpointDefBase {
  toolName?: string;
  expose?: readonly Transport[];
  /** MCP Apps widget for this tool's results (MCP transport only). */
  ui?: EndpointUiMeta;
  /** MCP behavioural hints (read-only / destructive / title) for hosts. */
  annotations?: EndpointToolAnnotations;
}

export type EndpointDef = HttpOnlyEndpointDef | ToolEndpointDef;

export interface ContractMeta<TScope extends string = string> {
  prefix: string;
  scope?: TScope;
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
  meta: { prefix: string },
  endpoints: T,
): ContractDef<T, 'public'>;
export function defineContract<
  TScope extends string,
  const T extends Record<string, EndpointDef>,
>(meta: { prefix: string; scope: TScope }, endpoints: T): ContractDef<T, TScope>;
export function defineContract(
  meta: ContractMeta,
  endpoints: Record<string, EndpointDef>,
): ContractDef {
  const toolTransports = new Map<string, { key: string; transports: Set<Transport> }>();
  for (const [key, ep] of Object.entries(endpoints)) {
    // `desc` is the description a model reads to decide whether to call the
    // tool — an empty one passes the type check but ships an unusable tool.
    if (ep.desc.trim() === '') {
      throw new Error(`Contract "${meta.prefix}": endpoint "${key}" has an empty desc`);
    }

    if (!('toolName' in ep) || !ep.toolName) continue;
    const transports = new Set(
      ep.expose
        ? ep.expose.filter((t) => t !== 'HTTP')
        : (['MCP', 'AGENT'] satisfies Transport[]),
    );
    // A `toolName` only means anything on a tool transport — setting one on an
    // HTTP-only endpoint is a contract mistake (the type also forbids it, but
    // a runtime-built contract bypasses the type).
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

// ─── Runtime Context (built by transport, loose types) ───

export interface RuntimeContext {
  params: unknown;
  input: unknown;
  file?: File;
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
  [key: string]: unknown;
}

// ─── Handler Context (typed, inferred from endpoint) ─────

export interface HandlerContext<TParams = undefined, TInput = undefined> {
  params: TParams;
  input: TInput;
  file?: File;
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

type MultipartArgs<E> = E extends { multipart: infer K extends string }
  ? { [P in K]: MultipartFile }
  : unknown;

type EndpointArgs<E> = InferInput<Prop<E, 'params'>> &
  InferInput<Prop<E, 'input'>> &
  MultipartArgs<E>;

type EndpointOutput<E> = Prop<E, 'output'> extends ZodType<infer O> ? O : undefined;

export type EndpointFn<E> = [keyof EndpointArgs<E>] extends [never]
  ? () => Promise<EndpointOutput<E>>
  : (args: EndpointArgs<E>) => Promise<EndpointOutput<E>>;

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
  ? () => Promise<EndpointOutput<E>>
  : (args: ArgsWith<E, Extra>) => Promise<EndpointOutput<E>>;

export type ScopedHttpClient<C extends Record<string, EndpointDef>, Extra> = {
  [K in keyof C as ExposesHttp<C[K]> extends true ? K : never]: ScopedEndpointFn<C[K], Extra>;
};

// A plain client is the scoped client with no extra keys (`unknown`), so
// `ScopedEndpointFn<E, unknown>` collapses to `EndpointFn<E>`.
export type TypedHttpClient<C extends Record<string, EndpointDef>> = ScopedHttpClient<
  C,
  unknown
>;
