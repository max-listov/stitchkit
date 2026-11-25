import { safeJsonParse } from '../../internal/safe-json';
import { isRecord } from '../../internal/typed';
import { jsonSchemaFields } from '../../json-schema/json-schema';
import { objectShapeKeys } from '../schema/schema';
import { type CliRunOptions, cliRunOptions, parseCliArgs } from './args';
import { coerceField, describeSchemaFields, looseCoerce } from './args-fields';
import type { CliFrameworkOptions } from './args-scan';
import { CliArgumentError } from './argument-error';
import type { CliConfig } from './config';
import { type CliCommandPresentation, cliPassthroughField } from './policy';

/** Best-effort coercion for a passthrough value of unknown schema type. */
function looseCoerceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(looseCoerceValue);
  return typeof value === 'string' ? looseCoerce(value) : value;
}

/**
 * Resolve the existing value of a passthrough target field to a record base to
 * merge onto. The field may still be a JSON *string* at this point — passthrough
 * runs before `executeToolMethod`'s `coerceJson` pass parses object fields — so
 * a `--parameters '{json}'` blob must be parsed here, or the passthrough bag
 * would clobber it (silent data loss). A non-JSON / non-record value yields
 * `undefined`: the bag replaces it, as before.
 */
function passthroughBase(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = safeJsonParse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON — fall through; the bag becomes the field value.
    }
  }
  return undefined;
}

/**
 * Move a command's unknown top-level args into a freeform object `field` — the
 * `passthrough` mechanism. A flag that is not a known schema key (and not the
 * target field itself) is loose-coerced and folded into `field`, so per-model
 * params arrive as flat `--flags` rather than a JSON blob.
 */
function collectPassthrough(
  toolArgs: Record<string, unknown>,
  field: string,
  knownKeys: string[],
): void {
  const known = new Set(knownKeys);
  const bag: Record<string, unknown> = {};
  for (const key of Object.keys(toolArgs)) {
    if (key === field || known.has(key)) continue;
    bag[key] = looseCoerceValue(toolArgs[key]);
    delete toolArgs[key];
  }
  if (Object.keys(bag).length === 0) return;
  const base = passthroughBase(toolArgs[field]);
  toolArgs[field] = base ? { ...base, ...bag } : bag;
}

type PreparedCliInvocation =
  | {
      ok: true;
      toolArgs: Record<string, unknown>;
      options: CliRunOptions;
    }
  | { ok: false; message: string };

export async function prepareInvocation(
  command: string,
  commandTokens: string[],
  separatedBefore: ReadonlySet<number>,
  framework: CliFrameworkOptions,
  descriptor: CliCommandPresentation,
  config: Pick<CliConfig, 'commandSettings'>,
  readStdin: () => Promise<string | null>,
): Promise<PreparedCliInvocation> {
  const passthroughField = cliPassthroughField(config, command);
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(commandTokens, descriptor.argumentSchema, {
      allowUnknown: passthroughField !== undefined,
      knownFields: jsonSchemaFields(descriptor.presentationSchema).map((field) => field.name),
      aliases: new Map([...descriptor.aliases].map(([field, alias]) => [alias, field])),
      positionals: descriptor.positionals,
      separatedBefore,
    });
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error;
    return { ok: false, message: error.message };
  }

  const { toolArgs } = parsed;
  const options = cliRunOptions(framework);
  const firstUnset = jsonSchemaFields(descriptor.presentationSchema).find(
    (field) => field.required && !(field.name in toolArgs) && field.schema.type !== 'boolean',
  );
  if (firstUnset) {
    const piped = await readStdin();
    if (piped !== null) {
      if (descriptor.positionals === undefined) {
        // Preserve the historical no-policy path byte-for-byte: stdin used to
        // arrive as a raw string and the command schema decided whether it fit.
        toolArgs[firstUnset.name] = piped;
      } else {
        // An explicit positional policy makes option-only fields obey the same
        // field-aware coercion as their equivalent `--field value` invocation,
        // without re-tokenising literal stdin text as shell flags.
        const fieldInfo = describeSchemaFields(descriptor.argumentSchema).get(firstUnset.name);
        try {
          toolArgs[firstUnset.name] = coerceField(fieldInfo, [piped], `--${firstUnset.name}`);
        } catch (error) {
          if (!(error instanceof CliArgumentError)) throw error;
          return { ok: false, message: error.message };
        }
      }
    }
  }

  if (passthroughField) {
    collectPassthrough(toolArgs, passthroughField, objectShapeKeys(descriptor.argumentSchema));
  }
  return { ok: true, toolArgs, options };
}
