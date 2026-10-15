/** Token admission precedes value conversion so no occurrence is silently discarded. */
import { isUnsafeKey } from '../../internal/safe-json';
import type { CliRunOptions } from './args';
import {
  appendCliOptionValue,
  type describeSchemaFields,
  type FieldInfo,
  parseReservedBool,
  separateBoolValue,
} from './args-fields';
import { appendCliFieldValue, cliFieldOption } from './args-json';
import {
  classifyLongOptionToken,
  isOptionToken,
  looksLikeOption,
  RESERVED_CLI_OPTIONS,
  VIEW_OPTIONS,
} from './args-route';
import { CliArgumentError } from './argument-error';

type CliConfigForParse = {
  allowUnknown?: boolean;
  optionAliases?: ReadonlyMap<string, string>;
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
  const options: CliRunOptions = {
    json: false,
    wait: false,
    quiet: false,
    dryRun: false,
    help: false,
  };

  const flags = new Map<string, string[]>();
  const jsonFields = new Set<string>();
  const literalBooleanFlags = new Set<string>();
  const frameworkFlags = new Map<string, string[]>();
  const viewFlags = new Map<string, string>();
  let ascending = false;
  const positionals: string[] = [];

  const pushFlag = (name: string, value: string, json = false): void => {
    appendCliFieldValue(flags, jsonFields, name, value, fieldFor(name), json);
  };

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
      options.help = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      const match = /^-([A-Za-z])(?:=(.*))?$/.exec(tok);
      const alias = match?.[1];
      const field = alias === undefined ? undefined : config.optionAliases?.get(alias);
      if (!alias || !field) throw new CliArgumentError(`Unknown option "${tok}"`);
      const inline = match?.[2];
      const info = fieldFor(field);
      if (info?.kind === 'boolean') {
        const separate = inline === undefined ? separateBoolValue(argv[i + 1]) : undefined;
        if (separate !== undefined) i++;
        pushFlag(field, inline ?? String(separate ?? true));
        if (inline !== undefined) parseReservedBool(field, inline);
        literalBooleanFlags.add(field);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
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

    if (option.globalKind === 'boolean') {
      const separate = value === undefined ? separateBoolValue(argv[i + 1]) : undefined;
      if (separate !== undefined) i++;
      // Help is a request, not a setting: asking twice asks once.
      if (name !== 'help') {
        appendCliOptionValue(frameworkFlags, name, value ?? String(separate ?? true), {
          kind: 'boolean',
        });
      }
      const enabled =
        value === undefined ? (separate ?? true) : parseReservedBool(name, value);
      if (name === 'dry-run') options.dryRun = enabled;
      else if (name === 'json') options.json = enabled;
      else if (name === 'wait') options.wait = enabled;
      else if (name === 'quiet') options.quiet = enabled;
      else if (name === 'ascending') ascending = enabled;
      else options.help = options.help || enabled;
      continue;
    }
    if (option.globalKind === 'value') {
      const next = argv[i + 1];
      value = value ?? next;
      if (value === undefined || (!option.inline && isOptionToken(value))) {
        throw new CliArgumentError(`--${name} requires a value`);
      }
      if (!option.inline) i++;
      appendCliOptionValue(frameworkFlags, name, value, { kind: 'string' });
      if (name === 'wait-timeout') {
        const timeout = Number(value);
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new CliArgumentError('--wait-timeout must be a positive number');
        }
        options.waitTimeout = timeout;
      } else if (VIEW_OPTIONS.has(name)) {
        viewFlags.set(name, value);
      } else {
        options.outputDir = value;
      }
      continue;
    }

    if (
      value === undefined &&
      name.startsWith('no-') &&
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
        const separate = separateBoolValue(argv[i + 1]);
        if (separate !== undefined) i++;
        pushFlag(name, String(separate ?? true));
        literalBooleanFlags.add(name);
        continue;
      }
      // The next token is the value unless it is itself an option: `--grep
      // -foo` and `--count -5` are values, `--grep --json` is a missing one.
      const next = argv[i + 1];
      if (next !== undefined && !isOptionToken(next)) {
        value = next;
        i++;
      } else {
        throw new CliArgumentError(`--${name} requires a value`);
      }
    }
    pushFlag(name, value, json);
  }
  return {
    options,
    flags,
    jsonFields,
    literalBooleanFlags,
    viewFlags,
    ascending,
    positionals,
  };
}
