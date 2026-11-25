/** Token admission precedes value conversion so no occurrence is silently discarded. */
import { isUnsafeKey } from '../../internal/safe-json';
import type { CliRunOptions } from './args';
import {
  classifyLongOptionToken,
  consumeFrameworkOptionToken,
  type FrameworkFlagState,
  isOptionToken,
  looksLikeOption,
  RESERVED_CLI_OPTIONS,
} from './args-classify';
import {
  type describeSchemaFields,
  type FieldInfo,
  parseReservedBool,
  separateBoolValue,
} from './args-fields';
import { appendCliFieldValue, cliFieldOption } from './args-json';
import { CliArgumentError } from './argument-error';

type CliConfigForParse = {
  allowUnknown?: boolean;
  aliases?: ReadonlyMap<string, string>;
  separatedBefore?: ReadonlySet<number>;
};
type FieldResolver = (name: string) => FieldInfo | undefined;

/** One invocation's argv, sorted into what each token is for. */
export interface CliTokens {
  options: CliRunOptions;
  /** Raw values per flag, in order; only an array field may have several. */
  flags: Map<string, string[]>;
  jsonFields: Set<string>;
  /** Boolean presence and aliases name exact fields, even when the name has a dot. */
  literalBooleanFlags: Set<string>;
  viewFlags: Map<string, string>;
  ascending: boolean;
  positionals: string[];
}

/**
 * Phase one: tokenise. Every refusal about the SHAPE of the command line —
 * an unknown option, a missing value, a prototype-polluting name, a repeated
 * non-array flag — happens here, before its raw multiplicity can be lost.
 */
export function readCliTokens(
  argv: readonly string[],
  fields: ReturnType<typeof describeSchemaFields>,
  fieldFor: FieldResolver,
  config: CliConfigForParse,
): CliTokens {
  const fwState: FrameworkFlagState = {
    fw: { json: false, wait: false, quiet: false, dryRun: false, help: false, schema: false },
    fwFlags: new Map(),
    viewFlags: new Map(),
    ascending: false,
  };

  const flags = new Map<string, string[]>();
  const jsonFields = new Set<string>();
  const literalBooleanFlags = new Set<string>();
  const positionals: string[] = [];

  const pushFlag = (name: string, value: string, json = false): void => {
    appendCliFieldValue(flags, jsonFields, name, value, fieldFor(name), json);
  };
  const adjacent = (index: number): boolean => !config.separatedBefore?.has(index);

  let optionsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (!optionsEnded && tok === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !looksLikeOption(tok)) {
      positionals.push(tok);
      continue;
    }
    if (tok === '-h') {
      fwState.fw.help = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      const match = /^-([A-Za-z])(?:=(.*))?$/.exec(tok);
      const alias = match?.[1];
      const field = alias === undefined ? undefined : config.aliases?.get(alias);
      if (!alias || !field) throw new CliArgumentError(`Unknown option "${tok}"`);
      const inline = match?.[2];
      const info = fieldFor(field);
      if (info?.kind === 'boolean') {
        const separate =
          inline === undefined && adjacent(i + 1) ? separateBoolValue(argv[i + 1]) : undefined;
        if (separate !== undefined) i++;
        pushFlag(field, inline ?? String(separate ?? true));
        if (inline !== undefined && info.pureBoolean === true) {
          parseReservedBool(field, inline);
        }
        literalBooleanFlags.add(field);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = adjacent(i + 1) ? argv[i + 1] : undefined;
        if (next !== undefined && !isOptionToken(next)) {
          value = next;
          i++;
        } else {
          throw new CliArgumentError(`--${field} requires a value`);
        }
      }
      pushFlag(field, value);
      continue;
    }
    const option = classifyLongOptionToken(tok);
    if (!option) throw new CliArgumentError(`Unknown option "${tok}"`);
    const { name, json } = cliFieldOption(option, fields);
    let { value } = option;
    if (name.length === 0) throw new CliArgumentError('Invalid empty option name');
    if (json && RESERVED_CLI_OPTIONS.has(name)) {
      throw new CliArgumentError(`--${name} is a framework option and does not accept :=JSON`);
    }

    if (option.globalKind !== undefined) {
      i = consumeFrameworkOptionToken(argv, i, option, fwState, {
        adjacent,
        onError: (error) => {
          throw error;
        },
      });
      continue;
    }

    if (
      value === undefined &&
      name.startsWith('no-') &&
      !fieldFor(name) &&
      fieldFor(name.slice(3))?.kind === 'boolean'
    ) {
      pushFlag(name.slice(3), 'false');
      literalBooleanFlags.add(name.slice(3));
      continue;
    }

    // Client-controlled names — refuse a prototype-polluting segment loudly
    // instead of silently dropping the argument.
    const unsafeSegment = name.split('.').find(isUnsafeKey);
    if (unsafeSegment !== undefined) {
      throw new CliArgumentError(`Unsafe option name "--${name}"`);
    }
    const info = fieldFor(name);
    const rootName = name.split('.')[0] ?? name;
    if (!fields.has(rootName) && !config.allowUnknown) {
      throw new CliArgumentError(`Unknown option "--${name}"`);
    }
    if (value === undefined) {
      if (info?.kind === 'boolean') {
        const separate = adjacent(i + 1) ? separateBoolValue(argv[i + 1]) : undefined;
        if (separate !== undefined) i++;
        pushFlag(name, String(separate ?? true));
        literalBooleanFlags.add(name);
        continue;
      }
      // The next token is the value unless it is itself an option: `--grep
      // -foo` and `--count -5` are values, `--grep --json` is a missing one.
      const next = adjacent(i + 1) ? argv[i + 1] : undefined;
      if (next !== undefined && !isOptionToken(next)) {
        value = next;
        i++;
      } else {
        throw new CliArgumentError(`--${name} requires a value`);
      }
    }
    pushFlag(name, value, json);
    if (option.inline && !json && info?.kind === 'boolean' && info.pureBoolean === true) {
      parseReservedBool(name, value);
    }
  }
  const { fw } = fwState;
  const options: CliRunOptions = {
    json: fw.json,
    wait: fw.wait,
    quiet: fw.quiet,
    dryRun: fw.dryRun,
    help: fw.help,
    schema: fw.schema,
    ...(fw.waitTimeout !== undefined && { waitTimeout: fw.waitTimeout }),
    ...(fw.outputDir !== undefined && { outputDir: fw.outputDir }),
  };
  return {
    options,
    flags,
    jsonFields,
    literalBooleanFlags,
    viewFlags: fwState.viewFlags,
    ascending: fwState.ascending,
    positionals,
  };
}
