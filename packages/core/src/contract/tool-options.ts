/**
 * What an endpoint may declare for its tool surfaces: the UI resource, the annotations, and the MCP input rounds with their resolver.
 */
import type { z } from 'zod';
import type { DeclaredToolView } from './tool-view';

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

/**
 * What the tool call looks like when the questions are chosen — the same
 * `params` / `input` the handler would receive, parsed by the contract's own
 * schemas.
 */
export interface McpInputRequiredCall {
  params: unknown;
  input: unknown;
}

/**
 * Choose this call's elicitation rounds from its arguments.
 *
 * The static list is declared before any call exists, which is enough when the
 * questions are a property of the operation. It is not enough when they are a
 * property of the ARGUMENTS — one model takes `aspect_ratio`, another takes
 * `duration`, a third needs an input image — and there the declared list can
 * only be empty, so the tool description ends up teaching the model to work
 * around a mechanism the protocol already has.
 *
 * Returning an empty list is a legitimate answer: this call needs nothing, run
 * it. Everything else about the mechanism is unchanged — the state is still
 * signed, still bound to the principal, the operation and the argument digest,
 * and still counted against `maxRounds`.
 *
 * The resolved list is fingerprinted into the signed state and re-checked on
 * every round, so a resolver that answers differently mid-conversation is
 * refused rather than silently asking round 2's question under round 1's key.
 */
export type McpInputRequiredResolver<
  TRequests extends readonly EndpointMcpInputRequired[] = readonly EndpointMcpInputRequired[],
> = (call: McpInputRequiredCall) => TRequests | Promise<TRequests>;

/** MCP-only execution policy attached to a contract or runtime tool. */
export interface EndpointMcpPolicy<
  TRequests extends readonly EndpointMcpInputRequired[] = readonly EndpointMcpInputRequired[],
> {
  /**
   * Ordered elicitation rounds — a fixed list, or a function of the parsed
   * arguments. Every key must be unique, in either form.
   */
  inputRequired: TRequests | McpInputRequiredResolver<TRequests>;
}

/**
 * Everything a tool surface — MCP, AGENT, CLI — reads from an endpoint that
 * HTTP does not: the name a model calls, the view it is answered with, the MCP
 * widget, host hints and elicitation rounds. One group, so an endpoint that can
 * never be a tool refuses all of it with one key, and a new tool option is
 * added in one place. `expose` is not in it: it chooses transports, HTTP
 * included. → ADR 0196.
 */
export interface EndpointToolOptions {
  /** The tool name on MCP / AGENT / CLI; unique per transport within a contract. */
  name?: string;
  /**
   * The answer on the tool surface when it is not the HTTP answer: input
   * defaults, a narrower output, a projection. Declared only by `withToolView`,
   * which types `project` against the endpoint's schemas.
   */
  view?: DeclaredToolView;
  /** MCP Apps widget for this tool's results (MCP transport only). */
  ui?: EndpointUiMeta;
  /** MCP behavioural hints (read-only / destructive / title) for hosts. */
  annotations?: EndpointToolAnnotations;
  /** Opt-in multi-round input gate; ignored by HTTP, Agent and CLI. */
  mcp?: EndpointMcpPolicy;
}
