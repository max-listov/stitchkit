/**
 * What a mounted tool body needs in order to be restartable — and nothing more.
 *
 * `mountAgent` has been able to put `step` / `sleep` / `waitFor` into a tool's
 * handler context for a while, but only `agent-runtime` could hand them in: they
 * arrived through the SDK call context that the runtime populates, so an
 * application that mounts contract tools and drives its own agent loop — which
 * is exactly who `mountAgent` is for — had no seam to put its own in, and wrote
 * the same durable bookkeeping beside its tools instead of inside them.
 *
 * Two things ship together. This PORT is what a tool body sees, and it is
 * deliberately a strict subset of `LocalStepDurability`: no `deliver`, no
 * record introspection — those belong to whoever owns the ledger, and a tool
 * body has no business reaching them. The ENGINE, `createLocalStepDurability`,
 * is exported from `stitchkit/tools` beside it: it is self-contained and needs a
 * ledger of two methods, so an application supplies those over the database it
 * already has and gets replay, absolute deadlines and park/deliver instead of
 * writing them. An application with its own ledger engine implements the port
 * directly. Either way the methods are bound before they reach the body, so a
 * class-based implementation keeps `this`.
 */
/**
 * What a durable record can hold. A step's result is written to a ledger and
 * read back in another process, so it has to be JSON — the constraint is part
 * of the port rather than a rule an implementation is trusted to remember.
 */
export type DurableJsonValue =
  | string
  | number
  | boolean
  | null
  | DurableJsonValue[]
  | { [key: string]: DurableJsonValue };

export interface ToolDurability {
  /**
   * Run `name` once and durably record its result; a replay returns the record
   * without running the body again.
   */
  step<T extends DurableJsonValue>(name: string, body: () => T | Promise<T>): Promise<T>;
  /** Wait `seconds`, retaining a deadline that survives a restart. */
  sleep(input: { seconds: number; name?: string }): Promise<void>;
  /** Park until `{ event, id }` is delivered, and resolve with its payload. */
  waitFor<T = unknown>(input: { event: string; id: string }): Promise<T>;
}

/**
 * Build the durability a single tool call gets.
 *
 * Called once per call with the provider's id for it, so an implementation can
 * key its ledger by the call the model actually made, and with the call's abort
 * signal so a park ends when the call does.
 */
export type ToolDurabilityFactory = (
  toolCallId: string,
  signal?: AbortSignal,
) => ToolDurability;
