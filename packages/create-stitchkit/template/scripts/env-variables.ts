import type { ProjectEnvVariable } from 'stitchkit/declaration';
import { z } from 'zod';
import { applicationVariables } from '../packages/config/src/variables';

/**
 * JSON Schema types this projection can carry into the declaration.
 *
 * Mapping `number` to `integer` would misrepresent fractional values and make
 * the declaration disagree with its Zod source. A type with no faithful shape
 * is rejected: the declaration format gains the shape, or the project stops
 * declaring that type.
 */
const SHAPE_BY_JSON_TYPE: Record<string, ProjectEnvVariable['shape']> = {
  integer: 'integer',
  boolean: 'boolean',
};

const JsonSchemaSchema = z.object({
  properties: z.record(
    z.string(),
    z.object({
      type: z.string().optional(),
      format: z.string().optional(),
      enum: z.array(z.unknown()).optional(),
    }),
  ),
  required: z.array(z.string()).optional(),
});

/**
 * The variables a deployment must supply, derived from the one Zod declaration.
 *
 * `required` follows the schema exactly: a variable with a default or an
 * `.optional()` is not required, and nothing here restates that judgement. An
 * enum carries its members, because "one of an unnamed set" tells a reader
 * without a TypeScript runtime nothing — and that reader is the whole point.
 */
export function renderEnvVariables(
  variables: Record<string, z.ZodType> = applicationVariables,
): ProjectEnvVariable[] {
  const json = JsonSchemaSchema.parse(
    z.toJSONSchema(z.object(variables), { io: 'input', unrepresentable: 'any' }),
  );
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties)
    .map(([name, property]) => describeVariable(name, property, required.has(name)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function describeVariable(
  name: string,
  property: { type?: string; format?: string; enum?: unknown[] },
  required: boolean,
): ProjectEnvVariable {
  if (property.enum) {
    // Members are rejected rather than stringified. `String(member)` would turn
    // numbers and booleans into text that does not match the value the Zod
    // schema accepts, so a deployment reading the declaration would supply
    // something the application then rejects — the declaration would be derived
    // and still wrong.
    const members = property.enum.filter((member) => typeof member === 'string');
    if (members.length !== property.enum.length) {
      throw new Error(
        `Environment variable ${name} declares a non-string enum member. The declaration format carries enum members as strings; declare it as a string enum, or extend the format first.`,
      );
    }
    return { name, shape: 'enum', required, members };
  }
  if (property.format === 'uri') return { name, shape: 'url', required };
  if (property.type === undefined || property.type === 'string') {
    return { name, shape: 'string', required };
  }
  const shape = SHAPE_BY_JSON_TYPE[property.type];
  if (!shape) {
    // Fail closed rather than describe the variable with the wrong shape: a
    // reader acting on `string` when the value is something else is worse off
    // than a reader told this project cannot describe it.
    throw new Error(
      `Cannot describe ${name}: no declaration shape for JSON Schema type "${property.type}".`,
    );
  }
  return { name, shape, required };
}
