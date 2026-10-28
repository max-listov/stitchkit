import { jsonSchemaFields } from '../../json-schema/json-schema';
import { assertUniqueToolName } from '../names';
import { RESERVED_CLI_OPTIONS } from './args-route';
import type { CliCommandPresentation } from './policy';

/** Local configuration faults throw; only argv field conflicts become unavailable. */
export function commandShapeIssue(
  name: string,
  descriptor: CliCommandPresentation,
  exists: boolean,
  passthroughField?: string,
  applicationGlobals: ReadonlySet<string> = new Set(),
): string | undefined {
  assertUniqueToolName(name, exists, 'CLI command');
  if (name === 'help' || name === 'version') {
    throw new Error(`[stitchkit] CLI command "${name}" is reserved`);
  }
  if (passthroughField !== undefined && descriptor.aliases.has(passthroughField)) {
    throw new Error(
      `[stitchkit] CLI command "${name}" cannot alias passthrough field "${passthroughField}"`,
    );
  }
  const fieldNames = jsonSchemaFields(descriptor.presentationSchema).map(
    (field) => field.name,
  );
  const conflicting = fieldNames.filter((field) => RESERVED_CLI_OPTIONS.has(field));
  if (conflicting.length > 0) {
    return `[stitchkit] CLI command "${name}" declares reserved option field(s): ${conflicting.join(', ')}`;
  }
  // An application global is stripped from argv before any command parses it,
  // so a command field of the same name could never receive a value. Say so at
  // the argv boundary instead of losing the argument at every call.
  const shadowed = fieldNames.filter((field) => applicationGlobals.has(field));
  if (shadowed.length > 0) {
    return `[stitchkit] CLI command "${name}" declares field(s) shadowed by application global options: ${shadowed.join(', ')}`;
  }
}
