/**
 * The single Zod → JSON Schema conversion point for the tools layer.
 *
 * MCP and agent both ultimately turn a contract schema into JSON Schema. This
 * is the one place stitchkit converts — with the options that match what the
 * transport SDKs emit, so a build-time validity probe tests the same thing the
 * SDK will later emit, not a divergent code path.
 */
import { z } from 'zod';

/** Conversion direction — `input` for tool arguments, `output` for results. */
export type JsonSchemaIo = 'input' | 'output';

/**
 * Convert a Zod schema to JSON Schema. Throws on a construct JSON Schema cannot
 * represent (`z.date()`, `z.bigint()`, `z.map()`, …). The caller decides what
 * to do with that failure — see `onIncompatibleSchema`.
 */
export function toJsonSchema(schema: z.ZodType, io: JsonSchemaIo): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    cycles: 'ref',
  });
}
