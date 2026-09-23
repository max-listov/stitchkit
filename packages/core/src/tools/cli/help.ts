import { type JsonSchemaField, jsonSchemaFields } from '../../json-schema/json-schema';
import { describeSchemaFields } from './args';
import type { CliCommandPresentation } from './policy';

const GLOBAL_OPTIONS = [
  ['--json', 'Emit compact success/error JSON records (for scripts)'],
  ['--wait', 'Block-poll an async result to a terminal state'],
  ['--wait-timeout <s>', 'Override the --wait timeout in seconds'],
  ['--output-dir <dir>', 'Download result media into a directory'],
  ['--quiet', 'Suppress non-essential stderr output'],
  ['--dry-run', 'Print the resolved call without executing it'],
  ['--help, -h', 'Show help for a command'],
  ['--help <text>', 'List only the commands matching a substring'],
  ['--count-by <field>', 'Count records per distinct value of a field'],
  ['--sum <field>', 'Total a numeric field, optionally grouped by --by'],
  ['--sort <field>', 'Order the records by a field, largest first'],
  ['--ascending', 'Flip --sort to smallest first'],
  ['--top <n>', 'Keep the n leading entries of the view asked for'],
  ['--table <a,b>', 'Render the named fields as an aligned table'],
] as const;

/** A human label for a flag's JSON-Schema type. */
function typeLabel(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return schema.enum.join('|');
  if (schema.type === 'array') return 'value…';
  if (typeof schema.type === 'string') return schema.type;
  return 'value';
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * A terse one-line command summary for the top-level help — the first sentence
 * of the (model-facing, often long) `desc`, capped. The full `desc` shows under
 * `<app> <command> --help`.
 */
function summarize(desc: string): string {
  const firstLine = desc.split('\n')[0]?.trim() ?? '';
  const firstSentence = firstLine.split('. ')[0]?.trim() ?? firstLine;
  const max = 72;
  return firstSentence.length > max
    ? `${firstSentence.slice(0, max - 1).trimEnd()}…`
    : firstSentence;
}

/** The application's own global options, rendered like the framework's own. */
function applicationOptionLines(fields: readonly JsonSchemaField[]): string[] {
  if (fields.length === 0) return [];
  const labels = new Map(
    fields.map((field) => [field.name, `--${field.name} <${typeLabel(field.schema)}>`]),
  );
  const width = Math.max(...fields.map((field) => labels.get(field.name)?.length ?? 0));
  return [
    '',
    'Application options:',
    ...fields.map((field) =>
      `  ${padRight(labels.get(field.name) ?? `--${field.name}`, width)}  ${field.description ?? ''}`.trimEnd(),
    ),
  ];
}

/**
 * Commands matching a substring, by name or by description.
 *
 * A discovered surface can be two hundred commands, at which point the full list
 * stops being an answer: it scrolls past a person and costs an agent the same
 * context an unfiltered result would. The description is searched too, because
 * the word someone knows is often in the sentence rather than the name.
 */
export function filterCommands(
  commands: Map<string, CliCommandPresentation>,
  filter: string,
): Map<string, CliCommandPresentation> {
  const needle = filter.toLowerCase();
  return new Map(
    [...commands].filter(
      ([command, descriptor]) =>
        command.toLowerCase().includes(needle) ||
        descriptor.description.toLowerCase().includes(needle),
    ),
  );
}

export function renderTopHelp(input: {
  name: string;
  version: string;
  commands: Map<string, CliCommandPresentation>;
  defaultCommand?: string;
  applicationOptions: readonly JsonSchemaField[];
  /** Why the managed surface is missing from this listing, when it is. */
  unavailable?: string;
  /** Narrow the listing; the counted line says what was left out. */
  filter?: string;
}): string {
  const { name, version, defaultCommand } = input;
  const commands =
    input.filter === undefined ? input.commands : filterCommands(input.commands, input.filter);
  const lines = [
    `${name} ${version}`,
    '',
    `Usage: ${name} ${defaultCommand ? '[command]' : '<command>'} [args] [--flags]`,
    '',
    input.filter === undefined
      ? 'Commands:'
      : `Commands matching "${input.filter}" (${commands.size} of ${input.commands.size}):`,
  ];
  const width = Math.max(0, ...[...commands.keys()].map((key) => key.length));
  for (const [command, descriptor] of commands) {
    lines.push(
      `  ${padRight(command, width)}  ${summarize(descriptor.description)}${command === defaultCommand ? ' (default)' : ''}`,
    );
  }
  // Naming the reason is the whole point: a command list that silently lost
  // most of itself reads as a CLI that never had those commands.
  if (input.unavailable !== undefined) {
    lines.push('', `Managed commands are unavailable: ${input.unavailable}`);
  }
  // A filtered listing is an answer to one question; repeating the whole option
  // table under it would bury the answer the reader asked for.
  if (input.filter !== undefined) {
    lines.push('', `Run "${name} <command> --help" for command-specific flags.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push('', 'Global options:');
  const optWidth = Math.max(...GLOBAL_OPTIONS.map(([flag]) => flag.length));
  for (const [flag, desc] of GLOBAL_OPTIONS)
    lines.push(`  ${padRight(flag, optWidth)}  ${desc}`);
  lines.push(...applicationOptionLines(input.applicationOptions));
  lines.push('', `Run "${name} <command> --help" for command-specific flags.`);
  return `${lines.join('\n')}\n`;
}

export function renderCommandHelp(
  name: string,
  command: string,
  descriptor: CliCommandPresentation,
  applicationOptions: readonly JsonSchemaField[] = [],
): string {
  const fields = jsonSchemaFields(descriptor.presentationSchema);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const kinds = describeSchemaFields(descriptor.argumentSchema);
  const positionals: JsonSchemaField[] = [];
  const positionalNames =
    descriptor.positionals ??
    [...kinds].filter(([, info]) => info.kind !== 'boolean').map(([fieldName]) => fieldName);
  for (const fieldName of positionalNames) {
    const field = fieldsByName.get(fieldName);
    if (field) positionals.push(field);
  }
  // Only an explicit policy makes a trailing array field variadic, so only
  // there does the usage line promise a list.
  const variadicTail =
    descriptor.positionals !== undefined &&
    kinds.get(descriptor.positionals[descriptor.positionals.length - 1] ?? '')?.kind ===
      'array'
      ? descriptor.positionals[descriptor.positionals.length - 1]
      : undefined;
  const positionalSyntax = new Map(
    positionals.map((field) => {
      const label = field.name === variadicTail ? `${field.name}...` : field.name;
      return [field.name, field.required ? `<${label}>` : `[${label}]`];
    }),
  );
  const usage = [
    `Usage: ${name} ${command}`,
    ...positionals.map((field) => positionalSyntax.get(field.name) ?? field.name),
    '[--flags]',
  ].join(' ');
  const lines = [descriptor.description, '', usage, ''];
  if (fields.length > 0) {
    lines.push('Arguments:');
    const labels = new Map(
      fields.map((field) => {
        const positional = positionalSyntax.get(field.name);
        const alias = descriptor.aliases.get(field.name);
        const option = alias ? `-${alias}, --${field.name}` : `--${field.name}`;
        return [field.name, positional ? `${positional} | ${option}` : option];
      }),
    );
    const width = Math.max(...fields.map((field) => labels.get(field.name)?.length ?? 0));
    for (const f of fields) {
      const req = f.required ? ' (required)' : '';
      const desc = f.description ? ` — ${f.description}` : '';
      const label = labels.get(f.name) ?? `--${f.name}`;
      lines.push(`  ${padRight(label, width)}  <${typeLabel(f.schema)}>${req}${desc}`);
    }
    lines.push('');
  }
  const applicationLines = applicationOptionLines(applicationOptions);
  if (applicationLines.length > 0) lines.push(...applicationLines.slice(1), '');
  return `${lines.join('\n')}\n`;
}
