/**
 * Whether an operation only reads, and how every tool surface says so.
 *
 * One rule, read in three places: the CLI decides from it whether a refused
 * view may withhold the result, the MCP server publishes it as the standard
 * `readOnlyHint`, and an MCP client connection carries a server's published
 * hints onto the tools it mounts — so a CLI built over an MCP surface
 * classifies a read exactly as a CLI built over the contract does.
 */
import { z } from 'zod';
import type { EndpointToolAnnotations } from '../contract/tool-options';
import type { OperationIdentity } from '../server/types';

type Operation = Pick<OperationIdentity, 'method' | 'annotations'>;

/**
 * Whether calling the operation again returns its answer without a new effect.
 *
 * The declared `readOnlyHint` decides in either direction. Without one, `GET`
 * is the contract's own statement that the endpoint reads — unless it declares
 * `destructiveHint: true`, which says the opposite in the same breath.
 */
export function isRepeatableRead(operation: Operation): boolean {
  const declared = operation.annotations;
  if (declared?.readOnlyHint !== undefined) return declared.readOnlyHint;
  return operation.method === 'GET' && declared?.destructiveHint !== true;
}

/**
 * The annotations a tool surface publishes for the operation: the declared
 * ones, with `readOnlyHint: true` stated for a read that declared none. A
 * declared `readOnlyHint`, either way, is published as written.
 */
export function publishedToolAnnotations(
  operation: Operation,
): EndpointToolAnnotations | undefined {
  const declared = operation.annotations;
  if (declared?.readOnlyHint !== undefined || !isRepeatableRead(operation)) return declared;
  return { ...declared, readOnlyHint: true };
}

/**
 * A foreign server's annotations, field by field. A field of the wrong type is
 * dropped and the rest kept: a hint is advice about a tool that works without
 * it, so a malformed one never costs the tool.
 */
const DiscoveredToolAnnotationsSchema = z.object({
  title: z.string().optional().catch(undefined),
  readOnlyHint: z.boolean().optional().catch(undefined),
  destructiveHint: z.boolean().optional().catch(undefined),
  idempotentHint: z.boolean().optional().catch(undefined),
  openWorldHint: z.boolean().optional().catch(undefined),
});

/** The hints another MCP server published for one of its tools, or `undefined` when it gave none. */
export function readDiscoveredToolAnnotations(
  raw: unknown,
): EndpointToolAnnotations | undefined {
  const parsed = DiscoveredToolAnnotationsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = parsed.data;
  const annotations: EndpointToolAnnotations = {
    ...(title !== undefined && { title }),
    ...(readOnlyHint !== undefined && { readOnlyHint }),
    ...(destructiveHint !== undefined && { destructiveHint }),
    ...(idempotentHint !== undefined && { idempotentHint }),
    ...(openWorldHint !== undefined && { openWorldHint }),
  };
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}
