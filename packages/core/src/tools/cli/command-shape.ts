import { jsonSchemaFields } from '../../json-schema/json-schema';
import type { ServiceDef } from '../../server/types';
import { projectedContractToolName } from '../internal/surface-projector';
import { assertUniqueToolName } from '../names';
import type { RuntimeToolDefinition } from '../runtime-tool-declaration';
import { isReservedCliCommandName, RESERVED_CLI_OPTIONS } from './args-route';
import type { CliCommandPresentation } from './policy';
import { cliStreamIdentity } from './stream-surface';

function assertCliCommandName(name: string): void {
  if (isReservedCliCommandName(name)) {
    throw new Error(
      `[stitchkit] CLI command "${name}" is reserved. Rename the command to a word outside the framework option syntax.`,
    );
  }
}

/** Check already-declared shell names before a native handler can run. */
export function assertStaticCliCommandNames(
  services: readonly ServiceDef[],
  runtimeTools: readonly RuntimeToolDefinition[],
): void {
  for (const tool of runtimeTools) {
    if (tool.transports?.includes('CLI')) assertCliCommandName(tool.name);
  }
  for (const service of services) {
    for (const [key, method] of Object.entries(service.methods)) {
      const name =
        projectedContractToolName(service.name, key, method, 'CLI') ??
        cliStreamIdentity(service.name, key, method)?.name;
      if (name !== undefined) assertCliCommandName(name);
    }
  }
}

/** Local configuration faults throw; only argv field conflicts become unavailable. */
export function commandShapeIssue(
  name: string,
  descriptor: CliCommandPresentation,
  exists: boolean,
  passthroughField?: string,
  applicationGlobals: ReadonlySet<string> = new Set(),
): string | undefined {
  assertUniqueToolName(name, exists, 'CLI command');
  assertCliCommandName(name);
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
