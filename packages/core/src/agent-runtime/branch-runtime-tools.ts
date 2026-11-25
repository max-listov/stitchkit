import { z } from 'zod';
import type { BranchIdentities } from './branch-identities';
import {
  ArtifactReadInputSchema,
  ArtifactReadOutputSchema,
  ArtifactSearchInputSchema,
  ArtifactSearchOutputSchema,
  ShellOutputSchema,
} from './coding-tool-contract';
import { AGENT_CODING_TOOL_NAMES } from './coding-tools';
import { DeferredAgentToolReceiptSchema } from './deferred-tool-types';
import { AGENT_EVENT_SEARCH_TOOL_SCHEMAS } from './event-search-tools';
import { InvocationPayloadReceiptSchema } from './invocation-schema';
import { canonicalAgentJson } from './store-events';

type Json = z.infer<ReturnType<typeof z.json>>;

/** The coding tools read and write spills: their references follow the spills' copies. */
function codingToolRecord(ids: BranchIdentities, name: string, value: Json, output: boolean) {
  if (
    name === AGENT_CODING_TOOL_NAMES.readOutput ||
    name === AGENT_CODING_TOOL_NAMES.searchOutput
  ) {
    const schema = output
      ? name === AGENT_CODING_TOOL_NAMES.readOutput
        ? ArtifactReadOutputSchema
        : ArtifactSearchOutputSchema
      : name === AGENT_CODING_TOOL_NAMES.readOutput
        ? ArtifactReadInputSchema
        : ArtifactSearchInputSchema;
    const parsed = schema.safeParse(value);
    if (!parsed.success) return undefined;
    return { ...parsed.data, reference: ids.reference('spill', parsed.data.reference) };
  }
  if (output && name === AGENT_CODING_TOOL_NAMES.runCommand) {
    const parsed = ShellOutputSchema.safeParse(value);
    if (!parsed.success) return undefined;
    return {
      ...parsed.data,
      ...(parsed.data.artifact && {
        artifact: {
          ...parsed.data.artifact,
          reference: ids.reference('spill', parsed.data.artifact.reference),
        },
      }),
    };
  }
  return undefined;
}

/**
 * A selection receipt names itself in `kind`, whatever the host called the
 * search tool, and selects tools for the run it was written in: its `runId`
 * follows that run's copy. One that names no run of this conversation is not
 * this conversation's receipt, and is judged as application data.
 */
function selectionReceipt(ids: BranchIdentities, value: Json) {
  const receipt = DeferredAgentToolReceiptSchema.safeParse(value);
  if (!receipt.success || canonicalAgentJson(receipt.data) !== canonicalAgentJson(value))
    return undefined;
  if (!ids.sourceIdentitiesOf(receipt.data.runId).has('run')) return undefined;
  return { ...receipt.data, runId: ids.reference('run', receipt.data.runId) };
}

const PayloadEventSchema = z
  .object({ kind: z.literal('provider/payload'), payload: z.json() })
  .passthrough();
const PayloadObservationSchema = z
  .object({
    kind: z.literal('runtime/branch-observation'),
    payload: z.object({ sourceKind: z.literal('provider/payload'), payload: z.json() }),
  })
  .passthrough();

/**
 * An event the model read keeps everything but an encrypted invocation body:
 * bytes cross a branch only under a fresh authorization, and there is none for
 * these. The receipt left in its place keeps the artifact's identity and hash.
 */
function withoutPayloadBody(event: Json): Json {
  const stripped = (payload: Json) => {
    const receipt = InvocationPayloadReceiptSchema.safeParse(payload);
    if (!receipt.success) return payload;
    const { iv: _iv, tag: _tag, ciphertext: _body, ...rest } = receipt.data;
    return rest;
  };
  const raw = PayloadEventSchema.safeParse(event);
  if (raw.success) return { ...raw.data, payload: stripped(raw.data.payload) };
  const observed = PayloadObservationSchema.safeParse(event);
  if (observed.success)
    return {
      ...observed.data,
      payload: { ...observed.data.payload, payload: stripped(observed.data.payload.payload) },
    };
  return event;
}

function eventSearchSchemas(name: string) {
  return Object.entries(AGENT_EVENT_SEARCH_TOOL_SCHEMAS).find(([tool]) => tool === name)?.[1];
}

/**
 * What the event search tools were asked and answered is a record of what the
 * model read, and crosses as it was: the runtime reads a branch's references
 * only through its own conversation, so a source address in it resolves to
 * nothing there. An input is recognised by its keys alone, because a call the
 * tool refused is still in the history.
 */
function eventSearchRecord(name: string, value: Json, output: boolean) {
  const schemas = eventSearchSchemas(name);
  if (!schemas) return undefined;
  if (!output) {
    const keys = Object.keys(schemas.input.shape);
    const isInput =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key));
    return isInput ? value : undefined;
  }
  if (!schemas.output.safeParse(value).success) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const events = value.events;
  if (Array.isArray(events)) return { ...value, events: events.map(withoutPayloadBody) };
  return withoutPayloadBody(value);
}

/**
 * What the runtime's own tools wrote into a conversation crosses a branch by
 * its type, never by the host's `applicationKeys`: those declare the
 * application's data, and these records are not the application's. Returns
 * `undefined` for anything else, which is then judged as application data; a
 * value that only resembles one of these — an extra field, another shape under
 * the same tool name — is exactly that.
 */
export function branchRuntimeToolRecord(
  ids: BranchIdentities,
  name: string,
  value: Json,
  output: boolean,
): Json | undefined {
  return (
    codingToolRecord(ids, name, value, output) ??
    (output ? selectionReceipt(ids, value) : undefined) ??
    eventSearchRecord(name, value, output)
  );
}
