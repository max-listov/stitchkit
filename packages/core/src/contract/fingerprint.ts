import { z } from 'zod';
import { resolveRouteParamsSchema } from '../internal/route-pattern';
import { canonicalDigest } from '../internal/stable-digest';
import { isRecord, typedEntries } from '../internal/typed';
import type { ContractDef, EndpointDef, HttpMethod } from './define';

/**
 * The identity of a set of contract operations: one digest over all of them,
 * and one per operation under its `prefix.key` name.
 *
 * Two sides that were built from different versions of a contract differ in
 * `fingerprint`; `operations` says where — an operation missing on one side is
 * a missing key, an operation whose schema moved is a different value.
 */
export const ContractFingerprintSchema = z.strictObject({
  fingerprint: z.string(),
  operations: z.record(z.string(), z.string()),
});
export type ContractFingerprint = z.infer<typeof ContractFingerprintSchema>;

/** What of one operation its identity is made of. */
export interface FingerprintedOperation {
  /** `prefix.key` — the stable `(service, action)` name. */
  name: string;
  method: HttpMethod;
  /** The route under the contract prefix. */
  path: string;
  params?: z.ZodType;
  input?: z.ZodType;
  output?: z.ZodType;
  /** The item schema of a streaming response. */
  item?: z.ZodType;
}

/** Annotations that describe a schema to a reader and change nothing a value must satisfy. */
const ANNOTATIONS = new Set(['description', 'title', 'examples', 'deprecated', '$comment']);

/**
 * A JSON Schema reduced to what constrains a value: annotations dropped, and
 * `required` — a set written as a list — put in one order, so reordering an
 * object's fields or rewording a field's description is not a new contract.
 */
function constraintsOf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(constraintsOf);
  if (!isRecord(schema)) return schema;
  const constraints: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    constraints[key] =
      key === 'required' && Array.isArray(value)
        ? [...value].sort()
        : key === 'properties' && isRecord(value)
          ? // Property NAMES are data here, never annotation keywords.
            Object.fromEntries(
              Object.entries(value).map(([name, property]) => [name, constraintsOf(property)]),
            )
          : constraintsOf(value);
  }
  return constraints;
}

function schemaIdentity(schema: z.ZodType | undefined, io: 'input' | 'output'): unknown {
  if (schema === undefined) return null;
  return constraintsOf(z.toJSONSchema(schema, { io, unrepresentable: 'any', cycles: 'ref' }));
}

/**
 * Digest a set of operations. Order-independent, synchronous, identical in
 * every runtime and on both ends of a connection: the digest is a function of
 * the names, routes and JSON Schemas alone.
 *
 * What it covers is the shape of the values: a field's description or the
 * order of an object's fields does not move it. What it does not cover: the
 * wire framing of a stream, multipart and raw-response declarations, and the
 * difference between types JSON Schema cannot represent (a `Date` against a
 * `bigint`), which all read as "anything" here.
 *
 * It identifies, it does not authenticate — the digest is 128 bits of a
 * non-cryptographic mix, built for two honest sides to notice that they
 * disagree.
 */
export function fingerprintOperations(
  operations: Iterable<FingerprintedOperation>,
): ContractFingerprint {
  const digests: Record<string, string> = {};
  for (const operation of operations) {
    if (Object.hasOwn(digests, operation.name)) {
      throw new Error(
        `[stitchkit] contract fingerprint: duplicate operation "${operation.name}"`,
      );
    }
    digests[operation.name] = canonicalDigest({
      method: operation.method,
      path: operation.path,
      params: schemaIdentity(operation.params, 'input'),
      input: schemaIdentity(operation.input, 'input'),
      output: schemaIdentity(operation.output, 'output'),
      item: schemaIdentity(operation.item, 'output'),
    });
  }
  return { fingerprint: canonicalDigest(digests), operations: digests };
}

type FingerprintedContract = ContractDef<Record<string, EndpointDef>, string>;

/**
 * The fingerprint of the operations a client of these contracts can call —
 * every endpoint HTTP carries. Stitchkit computes it; what a difference means
 * is the application's decision.
 */
export function contractFingerprint(
  contracts: FingerprintedContract | readonly FingerprintedContract[],
): ContractFingerprint {
  const list: readonly FingerprintedContract[] = Array.isArray(contracts)
    ? contracts
    : [contracts];
  return fingerprintOperations(list.flatMap(contractOperations));
}

function contractOperations(contract: FingerprintedContract): FingerprintedOperation[] {
  const operations: FingerprintedOperation[] = [];
  for (const [key, endpoint] of typedEntries(contract.endpoints)) {
    if (endpoint.expose && !endpoint.expose.includes('HTTP')) continue;
    operations.push({
      name: `${contract.meta.prefix}.${key}`,
      method: endpoint.method,
      path: endpoint.path,
      params: resolveRouteParamsSchema(endpoint.path, endpoint.params),
      input: endpoint.input,
      output: endpoint.output,
      item: 'stream' in endpoint ? endpoint.stream?.item : undefined,
    });
  }
  return operations;
}
