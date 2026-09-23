import { type ZodType, z } from 'zod';
import { isRecord } from '../internal/typed';
import type { EndpointDef, ToolEndpointDef, TransportSource } from './define';

/** What a tool view's `project` is told about the call besides the full result. */
export interface ToolViewCall<TInput = unknown> {
  /** The parsed input — the value the handler received, tool defaults applied. */
  input: TInput;
  /** Which tool transport the call entered on. */
  source: TransportSource;
}

/**
 * How an endpoint answers on the tool surface — MCP, AGENT and CLI — when that
 * answer is not its HTTP answer. HTTP, OpenAPI and the typed client keep the
 * full `input` / `output`; the handler stays one function that never learns
 * which surface called it. → ADR 0196.
 *
 * Declare it with {@link withToolView}: this runtime shape is deliberately
 * loose, and only the helper types `project` against the endpoint's schemas.
 */
export interface EndpointToolView {
  /**
   * Input values a tool call gets when it does not pass the key — applied
   * before the one parse by the endpoint's own `input`, so a model that asks
   * for nothing is not handed the full record's cost. Keys must be keys of
   * `input`, and never path params.
   */
  defaults?: Readonly<Record<string, unknown>>;
  /**
   * The schema of the tool answer. Without `project` the full result is sliced
   * by it; with `project` the projection is validated against it. Omitted, the
   * tool answer keeps the full `output` schema and `project` is required.
   */
  output?: ZodType<unknown>;
  /**
   * A pure, synchronous full → tool-answer function. It adds nothing the full
   * result does not carry: data the tool needs belongs in the full answer.
   */
  project?: (full: never, call: ToolViewCall<never>) => unknown;
}

/**
 * Marks a view as declared by {@link withToolView}. A view written as a bare
 * object would type `project` against nothing and let a slice that cannot hold
 * the full answer through; the mark makes the helper the one way to declare it.
 */
export const DECLARED_TOOL_VIEW: unique symbol = Symbol.for('stitchkit.toolView');

/** A tool view as `withToolView` produces it — the only form `tool.view` accepts. */
export interface DeclaredToolView extends EndpointToolView {
  readonly [DECLARED_TOOL_VIEW]: true;
}

type EndpointInputOutput<E> = E extends { input: infer I extends ZodType }
  ? z.output<I>
  : undefined;
type EndpointInputDefaults<E> = E extends { input: infer I extends ZodType }
  ? Partial<z.input<I>>
  : never;
type EndpointFullOutput<E> = E extends { output: infer O extends ZodType }
  ? z.output<O>
  : never;
type EndpointFullOutputInput<E> = E extends { output: infer O extends ZodType }
  ? z.input<O>
  : never;

type ToolViewProject<E, TResult> = (
  full: EndpointFullOutput<E>,
  call: ToolViewCall<EndpointInputOutput<E>>,
) => TResult;

/** A tool view whose answer has its own schema, reached by `project`. */
export interface ProjectedToolView<E, V extends ZodType> {
  defaults?: EndpointInputDefaults<E>;
  output: V;
  project: ToolViewProject<E, z.input<V>>;
}

/** A tool view that keeps the full schema and reshapes values within it. */
export interface ReshapedToolView<E> {
  defaults?: EndpointInputDefaults<E>;
  output?: undefined;
  project: ToolViewProject<E, EndpointFullOutputInput<E>>;
}

/** A tool view that slices the full result by a narrower schema. */
export interface SlicedToolView<E, V extends ZodType> {
  defaults?: EndpointInputDefaults<E>;
  output: V;
  project?: undefined;
}

/** The type error a slice produces when the full result does not fit its schema. */
export interface ToolViewSliceMismatch {
  'toolView.output must accept the full output — add a project, or narrow the schema': never;
}

type ToolViewEndpoint = ToolEndpointDef & { output: ZodType<unknown> };

/** The type error an HTTP-only endpoint produces: a view is an answer for tools. */
export interface ToolViewNeedsToolTransport {
  'toolView needs a tool transport — add MCP, AGENT or CLI to expose': never;
}

type ToolTransportEndpoint<E> = E extends { expose: readonly ['HTTP'] }
  ? ToolViewNeedsToolTransport
  : E;

/** The endpoint with its view in `tool.view`, next to any tool options it already had. */
export type WithToolView<E> = Omit<E, 'tool'> & {
  tool: (E extends { tool: infer T extends object } ? T : unknown) & {
    view: DeclaredToolView;
  };
};

/**
 * Declare an endpoint's tool-surface view with `project` typed against the
 * endpoint's own `input` and `output`.
 *
 * ```ts
 * list: withToolView(
 *   {
 *     method: 'GET', path: '/', desc: 'List users', input: ListQuery, output: UserList,
 *     tool: { name: 'user_list' },
 *   },
 *   {
 *     defaults: { include: [] },
 *     output: UserCardList,
 *     project: (full, { input }) => ({ items: full.items.map(toCard) }),
 *   },
 * ),
 * ```
 *
 * A view without `project` slices the full result by `output`; the full
 * result must then fit that schema, which the return type checks. The view
 * lands in `tool.view`, beside the endpoint's other tool options.
 */
export function withToolView<const E extends ToolViewEndpoint, V extends ZodType>(
  endpoint: E & ToolTransportEndpoint<E>,
  view: ProjectedToolView<E, V>,
): WithToolView<E>;
export function withToolView<const E extends ToolViewEndpoint>(
  endpoint: E & ToolTransportEndpoint<E>,
  view: ReshapedToolView<E>,
): WithToolView<E>;
export function withToolView<const E extends ToolViewEndpoint, V extends ZodType>(
  endpoint: E & ToolTransportEndpoint<E>,
  view: SlicedToolView<E, V>,
): [EndpointFullOutput<E>] extends [z.input<V>] ? WithToolView<E> : ToolViewSliceMismatch;
export function withToolView(
  endpoint: ToolViewEndpoint,
  view: EndpointToolView,
): ToolViewEndpoint & { tool: { view: DeclaredToolView } } {
  const declared: DeclaredToolView = { ...view, [DECLARED_TOOL_VIEW]: true };
  return { ...endpoint, tool: { ...endpoint.tool, view: declared } };
}

function objectKeys(schema: ZodType | undefined): Set<string> {
  return schema instanceof z.ZodObject ? new Set(Object.keys(schema.shape)) : new Set();
}

/**
 * The declaration-time half of the view rule, for a contract assembled past the
 * types as much as for one written through `withToolView`: a view only exists
 * where a tool surface does, and it can only change what a tool call is given
 * and shown — never which keys the endpoint accepts.
 */
export function assertToolView(prefix: string, key: string, ep: EndpointDef): void {
  const where = `Contract "${prefix}": endpoint "${key}" tool.view`;
  const tool: unknown = Reflect.get(ep, 'tool');
  const view: unknown = isRecord(tool) ? tool.view : undefined;
  if (!isRecord(view)) throw new Error(`${where} must be an object`);
  if (Reflect.get(view, DECLARED_TOOL_VIEW) !== true) {
    throw new Error(`${where} must be declared with withToolView, which types its project`);
  }

  if (ep.rawResponse || ep.rawBody || ep.multipart || 'responseMeta' in ep || 'stream' in ep) {
    throw new Error(
      `${where} is only for a JSON tool endpoint — this one is HTTP-only by kind`,
    );
  }
  if (!ep.output) {
    throw new Error(`${where} needs the endpoint's full output — the view is derived from it`);
  }

  const output: unknown = view.output;
  const project: unknown = view.project;
  if (output !== undefined && !(output instanceof z.ZodType)) {
    throw new Error(`${where}.output must be a Zod schema`);
  }
  if (project !== undefined && typeof project !== 'function') {
    throw new Error(`${where}.project must be a function`);
  }
  if (output === undefined && project === undefined) {
    throw new Error(`${where} declares neither output nor project — it would change nothing`);
  }

  const defaults: unknown = view.defaults;
  if (defaults === undefined) return;
  if (!isRecord(defaults)) throw new Error(`${where}.defaults must be an object`);
  const entries = Object.entries(defaults);
  if (entries.length === 0) return;
  if (!(ep.input instanceof z.ZodObject)) {
    throw new Error(`${where}.defaults needs an object input schema to name keys of`);
  }
  const inputKeys = objectKeys(ep.input);
  const paramKeys = objectKeys(ep.params);
  for (const [name, value] of entries) {
    if (paramKeys.has(name)) {
      throw new Error(
        `${where}.defaults.${name} is a path param — a route segment has no default`,
      );
    }
    if (!inputKeys.has(name)) {
      throw new Error(`${where}.defaults.${name} is not a key of the endpoint's input`);
    }
    const field = ep.input.shape[name];
    if (field === undefined || !z.safeParse(field, value).success) {
      throw new Error(`${where}.defaults.${name} is not a valid value for that input key`);
    }
  }
}
