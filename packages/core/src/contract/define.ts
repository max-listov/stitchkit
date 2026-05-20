import type { ZodType, z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const ALL_TRANSPORTS = ['HTTP', 'MCP', 'AGENT'] as const;
export type Transport = (typeof ALL_TRANSPORTS)[number];

export type TransportSource = 'http' | 'mcp' | 'agent';

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
   * HTTP client timeout in ms for this endpoint. Use it for slow synchronous
   * endpoints (AI generation) that need more than the client default. A
   * property of the endpoint — declared once, the typed client applies it.
   */
  timeout?: number;
}

interface HttpOnlyEndpointDef extends EndpointDefBase {
  expose: readonly ['HTTP'];
  toolName?: never;
}

interface ToolEndpointDef extends EndpointDefBase {
  toolName?: string;
  expose?: readonly Transport[];
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

type MultipartArgs<E> = E extends { multipart: infer K extends string }
  ? { [P in K]: Blob }
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

export type TypedHttpClient<C extends Record<string, EndpointDef>> = {
  [K in keyof C as ExposesHttp<C[K]> extends true ? K : never]: EndpointFn<C[K]>;
};
