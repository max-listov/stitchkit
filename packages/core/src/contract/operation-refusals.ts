/**
 * The codes a contract operation refuses with, declared with the factories of an error vocabulary
 * (`defineErrors`). One declaration feeds three readers: the server holds the handler to it, the
 * typed client narrows a refusal's `code` and `details` to it, and the operation's descriptor (the
 * `MethodDef`, OpenAPI, the surface manifest) carries it for a reader without types. → ADR 0330.
 */
import { type ClientErrorCode, isRetryableStatus, type StitchErrorCode } from './errors';
import type {
  ErrorDefinition,
  ErrorDetailsOutput,
  ErrorDetailsSchema,
} from './errors-factory';

/** One code an operation refuses with: an error factory from `defineErrors`, as declared. */
export interface RefusalDeclaration {
  readonly code: string;
  readonly definition: ErrorDefinition;
}

/** A declared refusal as a descriptor carries it: its status and retryability resolved. */
export interface DescribedRefusal {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly message?: string;
  readonly details?: ErrorDetailsSchema;
}

/**
 * A refusal as the typed client reads it — the shape an `ApiError` has — with a `code` the
 * operation declared and `details` typed by that code's schema.
 */
export interface DeclaredRefusal<TCode extends string, TDetails> {
  readonly code: TCode;
  readonly status: number;
  readonly details: TDetails;
  readonly message: string;
  readonly hint?: string;
  readonly traceId?: string;
  readonly retryable?: boolean;
}

type RefusalOf<TDeclared> = TDeclared extends {
  readonly code: infer TCode extends string;
  readonly definition: infer TDefinition extends ErrorDefinition;
}
  ? DeclaredRefusal<TCode, ErrorDetailsOutput<TDefinition>>
  : never;

/**
 * Every refusal a call of the endpoint `TEndpoint` can end with: its declared codes, each with its
 * typed `details`, plus the codes the framework and the client raise on any call.
 */
export type OperationRefusal<TEndpoint> =
  | (TEndpoint extends { readonly refuses: readonly (infer TDeclared)[] }
      ? RefusalOf<TDeclared>
      : never)
  | DeclaredRefusal<StitchErrorCode | ClientErrorCode, unknown>;

/** Refuse a malformed `refuses` where the contract is defined, naming the endpoint and index. */
export function assertEndpointRefusals(where: string, refuses: unknown): void {
  if (refuses === undefined) return;
  if (!Array.isArray(refuses)) {
    throw new Error(`${where}.refuses must be an array of error factories from defineErrors`);
  }
  const seen = new Set<string>();
  refuses.forEach((entry: unknown, index) => {
    const code = isDeclaration(entry) ? entry.code : undefined;
    if (code === undefined) {
      throw new Error(
        `${where}.refuses[${index}] is not an error factory from defineErrors — declare the code there and list its factory`,
      );
    }
    if (seen.has(code)) throw new Error(`${where}.refuses names "${code}" twice`);
    seen.add(code);
  });
}

function isDeclaration(entry: unknown): entry is RefusalDeclaration {
  if (typeof entry !== 'function' && (typeof entry !== 'object' || entry === null))
    return false;
  const code: unknown = Reflect.get(entry, 'code');
  const definition: unknown = Reflect.get(entry, 'definition');
  return (
    typeof code === 'string' &&
    code.length > 0 &&
    typeof definition === 'object' &&
    definition !== null &&
    typeof Reflect.get(definition, 'status') === 'number'
  );
}

/** The descriptor form of an operation's declared refusals, or `undefined` when it declares none. */
export function describeRefusals(
  refuses: readonly RefusalDeclaration[] | undefined,
): readonly DescribedRefusal[] | undefined {
  if (refuses === undefined) return undefined;
  return Object.freeze(
    refuses.map(({ code, definition }) =>
      Object.freeze({
        code,
        status: definition.status,
        retryable: definition.retryable ?? isRetryableStatus(definition.status),
        ...(definition.message !== undefined && { message: definition.message }),
        ...(definition.details !== undefined && { details: definition.details }),
      }),
    ),
  );
}
