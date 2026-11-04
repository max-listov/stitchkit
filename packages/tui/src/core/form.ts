import { z } from 'zod';
import { applyTerminalTextEdit, type TerminalTextEdit } from './text';

export const TerminalFormFieldSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    /**
     * How the field is typed and read: `text` and `secret` stay strings, numbers
     * must be finite (`integer` whole), `boolean` and `choice` cycle through
     * their values instead of being typed, `json` is any JSON value.
     */
    kind: z.enum(['text', 'secret', 'number', 'integer', 'boolean', 'choice', 'json']),
    required: z.boolean().default(false),
    /** The values a choice cycles through, shown as text and read back as themselves. */
    choices: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    defaultValue: z.unknown().optional(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
  })
  .strict()
  .refine((field) => field.kind !== 'choice' || (field.choices?.length ?? 0) > 0, {
    message: 'A choice field needs at least one choice',
  });

export type TerminalFormField = z.output<typeof TerminalFormFieldSchema>;
export type TerminalFormFieldInput = z.input<typeof TerminalFormFieldSchema>;

export interface TerminalFormState {
  readonly fields: readonly TerminalFormField[];
  /** What the reader typed or chose, per field, as text. */
  readonly drafts: Readonly<Record<string, string>>;
  /** Shown once a field was left or the form was submitted. */
  readonly errors: Readonly<Record<string, string>>;
  readonly focus: number;
  readonly submitted: boolean;
  /** The last accepted submission, numbered so a widget delivers each one once. */
  readonly accepted: { serial: number; values: Record<string, unknown> } | null;
}

export type TerminalFormAction =
  | { type: 'focus'; name: string }
  | { type: 'move'; delta: number }
  | { type: 'set'; name?: string; text: string }
  | { type: 'edit'; name?: string; edit: TerminalTextEdit }
  | { type: 'cycle'; name?: string; delta: number }
  | { type: 'clear'; name?: string }
  | { type: 'submit' };

export type TerminalFormResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/** The labels a form's messages use; English unless the product passes its own. */
export interface TerminalFormMessages {
  required: string;
  number: string;
  integer: string;
  choice: (choices: readonly string[]) => string;
  json: (reason: string) => string;
}

export const terminalFormMessages: TerminalFormMessages = {
  required: 'Required',
  number: 'Expected a number',
  integer: 'Expected a whole number',
  choice: (choices) => `Choose one of: ${choices.join(', ')}`,
  json: (reason) => `Invalid JSON: ${reason}`,
};

function draftOf(field: TerminalFormField): string {
  const value = field.defaultValue;
  if (value === undefined || value === null) return '';
  if (field.kind === 'json') return JSON.stringify(value);
  return String(value);
}

/** One field read from its draft: a value, nothing (blank optional), or an error. */
function readField(
  field: TerminalFormField,
  draft: string,
  messages: TerminalFormMessages,
): { value?: unknown; error?: string } {
  const text = field.kind === 'text' || field.kind === 'secret' ? draft : draft.trim();
  if (text === '') return field.required ? { error: messages.required } : {};
  switch (field.kind) {
    case 'text':
    case 'secret':
      return { value: text };
    case 'number':
    case 'integer': {
      // Decimal notation only: `Number` would also read `0x10`, `0b1` and `Infinity`.
      if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return { error: messages.number };
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: messages.number };
      if (field.kind === 'integer' && !Number.isInteger(value))
        return { error: messages.integer };
      return { value };
    }
    case 'boolean':
      return text === 'true' || text === 'false'
        ? { value: text === 'true' }
        : { error: messages.choice(['true', 'false']) };
    case 'choice': {
      const choice = field.choices?.find((candidate) => String(candidate) === text);
      return choice === undefined
        ? { error: messages.choice((field.choices ?? []).map(String)) }
        : { value: choice };
    }
    case 'json':
      try {
        return { value: JSON.parse(text) };
      } catch (error) {
        return {
          error: messages.json(error instanceof Error ? error.message : String(error)),
        };
      }
  }
}

export function createTerminalForm(
  fields: readonly TerminalFormFieldInput[],
): TerminalFormState {
  const parsed = z.array(TerminalFormFieldSchema).parse(fields);
  const names = new Set<string>();
  for (const field of parsed) {
    if (names.has(field.name))
      throw new Error(`Terminal form field ${field.name} is declared twice`);
    names.add(field.name);
  }
  return {
    fields: parsed,
    drafts: Object.fromEntries(parsed.map((field) => [field.name, draftOf(field)])),
    errors: {},
    focus: 0,
    submitted: false,
    accepted: null,
  };
}

function fieldNamed(state: TerminalFormState, name?: string): TerminalFormField {
  const field =
    name === undefined ? state.fields[state.focus] : state.fields.find((f) => f.name === name);
  if (!field) throw new Error(`Unknown terminal form field: ${name ?? `#${state.focus}`}`);
  return field;
}

/** Values when every field reads, otherwise every field's error. */
export function readTerminalForm(
  state: TerminalFormState,
  messages: TerminalFormMessages = terminalFormMessages,
): TerminalFormResult {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of state.fields) {
    const read = readField(field, state.drafts[field.name] ?? '', messages);
    if (read.error !== undefined) errors[field.name] = read.error;
    else if ('value' in read) values[field.name] = read.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}

export function reduceTerminalForm(
  state: TerminalFormState,
  action: TerminalFormAction,
  messages: TerminalFormMessages = terminalFormMessages,
): TerminalFormState {
  const validate = (next: TerminalFormState, name: string): TerminalFormState => {
    const field = fieldNamed(next, name);
    const read = readField(field, next.drafts[name] ?? '', messages);
    const errors = { ...next.errors };
    if (read.error !== undefined) errors[name] = read.error;
    else delete errors[name];
    return { ...next, errors };
  };
  switch (action.type) {
    case 'focus':
    case 'move': {
      if (state.fields.length === 0) return state;
      const target =
        action.type === 'focus'
          ? state.fields.findIndex(({ name }) => name === action.name)
          : Math.min(Math.max(0, state.focus + action.delta), state.fields.length - 1);
      if (target < 0)
        throw new Error(
          `Unknown terminal form field: ${action.type === 'focus' ? action.name : ''}`,
        );
      const left = state.fields[state.focus];
      // Leaving a field is when its error becomes worth showing.
      const checked = left && target !== state.focus ? validate(state, left.name) : state;
      return { ...checked, focus: target };
    }
    case 'set':
    case 'edit': {
      const field = fieldNamed(state, action.name);
      const text =
        action.type === 'set'
          ? action.text
          : applyTerminalTextEdit(state.drafts[field.name] ?? '', action.edit);
      const next = { ...state, drafts: { ...state.drafts, [field.name]: text } };
      return state.errors[field.name] !== undefined || state.submitted
        ? validate(next, field.name)
        : next;
    }
    case 'cycle': {
      const field = fieldNamed(state, action.name);
      const options =
        field.kind === 'boolean'
          ? ['true', 'false']
          : field.kind === 'choice'
            ? (field.choices ?? []).map(String)
            : null;
      if (options === null) return state;
      const all = field.required ? options : ['', ...options];
      const index = all.indexOf(state.drafts[field.name] ?? '');
      const next =
        all[(((index + action.delta) % all.length) + all.length) % all.length] ?? '';
      return validate(
        { ...state, drafts: { ...state.drafts, [field.name]: next } },
        field.name,
      );
    }
    case 'clear': {
      const field = fieldNamed(state, action.name);
      const next = { ...state, drafts: { ...state.drafts, [field.name]: '' } };
      return state.errors[field.name] !== undefined || state.submitted
        ? validate(next, field.name)
        : next;
    }
    case 'submit': {
      const result = readTerminalForm(state, messages);
      if (result.ok) {
        const serial = (state.accepted?.serial ?? 0) + 1;
        return {
          ...state,
          errors: {},
          submitted: true,
          accepted: { serial, values: result.values },
        };
      }
      const first = state.fields.findIndex(({ name }) => result.errors[name] !== undefined);
      return {
        ...state,
        errors: result.errors,
        submitted: true,
        focus: first < 0 ? state.focus : first,
      };
    }
  }
}

const JsonSchemaPropertySchema = z
  .object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    enum: z.array(z.unknown()).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.unknown().optional(),
    format: z.string().optional(),
    writeOnly: z.boolean().optional(),
  })
  .loose();

const JsonSchemaObjectSchema = z
  .object({
    properties: z.record(z.string(), z.unknown()).default({}),
    required: z.array(z.string()).default([]),
  })
  .loose();

/**
 * Form fields for a JSON Schema object (the shape `z.toJSONSchema` and MCP tool
 * inputs use): string enums become choices, `format: password` or `writeOnly`
 * a secret, numbers and integers stay numeric, and anything structured — arrays,
 * objects, unions — is typed as JSON.
 */
export function terminalFormFieldsFromJsonSchema(schema: unknown): TerminalFormFieldInput[] {
  const object = JsonSchemaObjectSchema.parse(schema);
  return Object.entries(object.properties).map(([name, raw]) => {
    // `true` is a valid JSON Schema that accepts anything; `false` accepts nothing.
    const property = JsonSchemaPropertySchema.parse(
      typeof raw === 'boolean' ? {} : (raw ?? {}),
    );
    const types = (Array.isArray(property.type) ? property.type : [property.type]).filter(
      (type): type is string => type !== undefined && type !== 'null',
    );
    const type = types.length === 1 ? types[0] : undefined;
    // `null` in an enum means the field may be left empty, not a value to pick.
    const listed = property.enum?.filter((value) => value !== null);
    const scalars = listed?.filter(
      (value): value is string | number | boolean =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    );
    const choices =
      scalars !== undefined && scalars.length > 0 && scalars.length === listed?.length
        ? scalars
        : undefined;
    const kind: TerminalFormField['kind'] = choices
      ? 'choice'
      : type === 'string'
        ? property.format === 'password' || property.writeOnly
          ? 'secret'
          : 'text'
        : type === 'number'
          ? 'number'
          : type === 'integer'
            ? 'integer'
            : type === 'boolean'
              ? 'boolean'
              : 'json';
    return {
      name,
      label: property.title ?? name,
      kind,
      required: object.required.includes(name),
      ...(choices && { choices }),
      ...(property.default !== undefined && { defaultValue: property.default }),
      ...(property.description !== undefined && { description: property.description }),
    };
  });
}
