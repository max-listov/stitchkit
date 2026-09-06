/**
 * Declare an application's domain errors once. Each definition owns its HTTP
 * status, its default message and an optional Zod schema for structured
 * details; generated factories construct (but do not throw) branded `AppError`
 * instances.
 *
 * ```ts
 * export const appErrors = defineErrors({
 *   SESSION_NOT_FOUND: { status: 404, message: 'No such session' },
 *   QUOTA_EXCEEDED: {
 *     status: 429,
 *     message: 'Monthly quota exhausted',
 *     details: z.object({ retryAfterSeconds: z.number().int().positive() }),
 *   },
 * })
 *
 * throw appErrors.errors.SESSION_NOT_FOUND()
 * throw appErrors.errors.QUOTA_EXCEEDED({
 *   details: { retryAfterSeconds: 30 },
 *   hint: 'Wait for the current window to expire',
 * })
 * ```
 */
import { z } from 'zod';
import { mapObjectTypeBoundary, transportResult, typedEntries } from '../internal/typed';
import {
  AppError,
  isStitchErrorCode,
  STITCH_ERROR_STATUS,
  type StitchErrorCode,
} from './errors';

/** Supported structured-details schemas: a required or optional Zod object. */
export type ErrorDetailsSchema = z.ZodObject | z.ZodOptional<z.ZodObject>;

/**
 * One domain error definition. Omitting `details` forbids structured details.
 *
 * `message` is the code's default human-readable text: without it `AppError`
 * falls back to the code itself, and every `throw` site has to repeat the
 * sentence. A per-call `message` still wins.
 */
export type ErrorDefinition =
  | { readonly status: number; readonly message?: string; readonly details?: never }
  | {
      readonly status: number;
      readonly message?: string;
      readonly details: ErrorDetailsSchema;
    };

export type ErrorDefinitions = Record<string, ErrorDefinition>;

/** Parsed details retained by the constructed `AppError`. */
export type ErrorDetailsOutput<TDefinition extends ErrorDefinition> = TDefinition extends {
  details: infer TSchema extends ErrorDetailsSchema;
}
  ? Extract<z.output<TSchema>, Record<string, unknown> | undefined>
  : undefined;

/** AppError instance with required details refined when its schema is required. */
export type DefinedAppError<
  TCode extends string,
  TDefinition extends ErrorDefinition,
> = AppError<TCode, ErrorDetailsOutput<TDefinition>> &
  (TDefinition extends { details: infer TSchema extends ErrorDetailsSchema }
    ? undefined extends z.output<TSchema>
      ? object
      : { readonly details: ErrorDetailsOutput<TDefinition> }
    : object);

/**
 * Factory arguments inferred from the definition: details are forbidden,
 * required or optional according to the declared schema.
 */
export type ErrorFactoryArguments<TDefinition extends ErrorDefinition> = TDefinition extends {
  details: infer TSchema extends ErrorDetailsSchema;
}
  ? undefined extends z.input<TSchema>
    ? [
        options?: {
          message?: string;
          details?: Exclude<z.input<TSchema>, undefined>;
          hint?: string;
        },
      ]
    : [
        options: {
          message?: string;
          details: z.input<TSchema>;
          hint?: string;
        },
      ]
  : [options?: { message?: string; details?: never; hint?: string }];

/** Typed constructor for one declared domain error code. */
export type ErrorFactory<TCode extends string, TDefinition extends ErrorDefinition> = (
  ...args: ErrorFactoryArguments<TDefinition>
) => DefinedAppError<TCode, TDefinition>;

export type ErrorFactories<TDefinitions extends ErrorDefinitions> = {
  readonly [TCode in keyof TDefinitions]: ErrorFactory<TCode & string, TDefinitions[TCode]>;
};

/**
 * `const` inference keeps only the keys a definition actually wrote, so a
 * registry that mixes codes with and without `message` has no common `message`
 * key — and `definitions[code].message`, the whole point of declaring it, would
 * not type-check. Normalising the optional key restores that lookup.
 *
 * A declared literal stays literal (`'gone' & string` is `'gone'`); this only
 * adds the key where a definition omitted it.
 */
export type FrozenErrorDefinitions<TDefinitions extends ErrorDefinitions> = {
  readonly [TCode in keyof TDefinitions]: Readonly<TDefinitions[TCode]> & {
    readonly message?: string;
  };
};

/** The union of an application's declared error codes. */
export type ErrorVocabularyCode<TDefinitions extends ErrorDefinitions> = Extract<
  keyof TDefinitions,
  string
>;

export type ErrorVocabularyMapping<TDefinitions extends ErrorDefinitions> =
  | {
      /** Require an explicit application code for every Stitchkit code. */
      exhaustive: true;
      map: Record<StitchErrorCode, ErrorVocabularyCode<TDefinitions>>;
      fallback?: never;
    }
  | {
      exhaustive?: false;
      /** Per-framework-code overrides. */
      map?: Partial<Record<StitchErrorCode, ErrorVocabularyCode<TDefinitions>>>;
      /** Explicit HTTP-status fallback; no key-order inference is performed. */
      fallback?: Partial<Record<number, ErrorVocabularyCode<TDefinitions>>>;
    };

export type VocabularyCodeMap<
  TDefinitions extends ErrorDefinitions,
  TMapping extends ErrorVocabularyMapping<TDefinitions> | undefined,
> = TMapping extends { exhaustive: true }
  ? Readonly<Record<StitchErrorCode, ErrorVocabularyCode<TDefinitions>>>
  : Readonly<Partial<Record<StitchErrorCode, ErrorVocabularyCode<TDefinitions>>>>;

/** The immutable handle returned by `defineErrors`. */
export interface DefinedErrors<
  TDefinitions extends ErrorDefinitions,
  TMapping extends ErrorVocabularyMapping<TDefinitions> | undefined = undefined,
> {
  /** One typed `AppError` constructor per code. The caller chooses when to throw. */
  readonly errors: ErrorFactories<TDefinitions>;
  /** Code literals for client-side matching without magic strings. */
  readonly codes: { readonly [TCode in keyof TDefinitions]: TCode & string };
  /** Read-only definitions; status and details schemas remain one source of truth. */
  readonly definitions: FrozenErrorDefinitions<TDefinitions>;
  /** Type guard — is `code` one of this application's declared codes? */
  readonly isCode: (code: string) => code is Extract<keyof TDefinitions, string>;
  /** Framework-code projection consumed directly by `createErrorHook`. */
  readonly codeMap: VocabularyCodeMap<TDefinitions, TMapping>;
}

interface RuntimeErrorOptions {
  message?: string;
  details?: unknown;
  hint?: string;
}

function isErrorDetailsSchema(value: unknown): value is ErrorDetailsSchema {
  return (
    value instanceof z.ZodObject ||
    (value instanceof z.ZodOptional && value.unwrap() instanceof z.ZodObject)
  );
}

function validateDefinition(code: string, definition: ErrorDefinition): void {
  if (
    !Number.isInteger(definition.status) ||
    definition.status < 400 ||
    definition.status > 599
  ) {
    throw new Error(
      `[stitchkit] Error "${code}" must declare an integer HTTP status from 400 to 599`,
    );
  }
  if (definition.details !== undefined && !isErrorDetailsSchema(definition.details)) {
    throw new Error(
      `[stitchkit] Error "${code}" details must be a Zod object or optional Zod object`,
    );
  }
  if (
    definition.message !== undefined &&
    (typeof definition.message !== 'string' || definition.message.trim() === '')
  ) {
    throw new Error(`[stitchkit] Error "${code}" message must be a non-empty string`);
  }
}

/** Declare an immutable, Zod-first domain error vocabulary. */
export function defineErrors<
  const TDefinitions extends ErrorDefinitions,
  const TMapping extends ErrorVocabularyMapping<TDefinitions> | undefined = undefined,
>(source: TDefinitions, mapping?: TMapping): DefinedErrors<TDefinitions, TMapping> {
  const definitions = mapObjectTypeBoundary<
    TDefinitions,
    FrozenErrorDefinitions<TDefinitions>
  >(source, (code, definition) => {
    const name = String(code);
    validateDefinition(name, definition);
    return Object.freeze({ ...definition });
  });
  Object.freeze(definitions);

  const errors = mapObjectTypeBoundary<
    FrozenErrorDefinitions<TDefinitions>,
    ErrorFactories<TDefinitions>
  >(definitions, (code, definition) => {
    const name = String(code);
    return (options: RuntimeErrorOptions = {}) => {
      // Per-call text wins; then the declared default; `AppError` falls back to
      // the code itself, which is the pre-`message` behaviour.
      const message = options.message ?? definition.message;
      if (definition.details === undefined) {
        if ('details' in options) {
          throw new Error(`[stitchkit] Error "${name}" does not declare details`);
        }
        return new AppError(name, message, definition.status, undefined, options.hint);
      }
      const details = definition.details.parse(options.details);
      return new AppError(name, message, definition.status, details, options.hint);
    };
  });
  Object.freeze(errors);

  const codes = mapObjectTypeBoundary<
    FrozenErrorDefinitions<TDefinitions>,
    { readonly [TCode in keyof TDefinitions]: TCode & string }
  >(definitions, (code) => String(code));
  Object.freeze(codes);

  const known = new Set(Object.keys(definitions));
  for (const [code, target] of Object.entries(mapping?.map ?? {})) {
    if (!isStitchErrorCode(code)) {
      throw new Error(
        `[stitchkit] Error vocabulary contains unknown framework code "${code}"`,
      );
    }
    if (typeof target !== 'string' || !known.has(target)) {
      throw new Error(
        `[stitchkit] Error vocabulary maps "${code}" to undeclared code "${String(target)}"`,
      );
    }
    // The wire carries the framework's status with the application's code;
    // a code declared under another status would name one thing and carry
    // another, so the map is refused where the fallback already is.
    const status = STITCH_ERROR_STATUS[code];
    if (definitions[target]?.status !== status) {
      throw new Error(
        `[stitchkit] Error vocabulary maps "${code}" (${status}) to "${target}", declared with status ${String(definitions[target]?.status)}`,
      );
    }
  }
  for (const [statusText, target] of Object.entries(mapping?.fallback ?? {})) {
    const status = Number(statusText);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new Error(
        `[stitchkit] Error vocabulary fallback status "${statusText}" must be an integer from 400 to 599`,
      );
    }
    if (typeof target !== 'string' || !known.has(target)) {
      throw new Error(
        `[stitchkit] Error vocabulary fallback ${status} names undeclared code "${String(target)}"`,
      );
    }
    if (definitions[target]?.status !== status) {
      throw new Error(
        `[stitchkit] Error vocabulary fallback ${status} must name a code with status ${status}`,
      );
    }
  }
  if (mapping?.exhaustive === true) {
    for (const code of Object.keys(STITCH_ERROR_STATUS)) {
      if (!Object.hasOwn(mapping.map, code)) {
        throw new Error(`[stitchkit] Exhaustive error vocabulary is missing "${code}"`);
      }
    }
  }

  const codeMap: Partial<Record<StitchErrorCode, ErrorVocabularyCode<TDefinitions>>> = {};
  for (const [stitchCode, status] of typedEntries(STITCH_ERROR_STATUS)) {
    const code = mapping?.map?.[stitchCode] ?? mapping?.fallback?.[status];
    if (code === undefined) continue;
    if (!known.has(code)) {
      throw new Error(
        `[stitchkit] Error vocabulary maps "${stitchCode}" to undeclared code "${code}"`,
      );
    }
    codeMap[stitchCode] = code;
  }
  Object.freeze(codeMap);
  const vocabularyCodeMap =
    transportResult<VocabularyCodeMap<TDefinitions, TMapping>>(codeMap);

  return Object.freeze({
    errors,
    codes,
    definitions,
    isCode: (code: string): code is Extract<keyof TDefinitions, string> => known.has(code),
    codeMap: vocabularyCodeMap,
  });
}
