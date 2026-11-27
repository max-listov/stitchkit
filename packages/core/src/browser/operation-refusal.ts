/**
 * Read a typed-client rejection as a refusal its operation declared. The code must be one the
 * operation declared, one the framework or the client raises on any call; a declared code's
 * `details` must pass its schema. Anything else — another error, a code from a newer contract,
 * details the schema refuses — reads as no refusal rather than as a false type. → ADR 0330.
 */
import type { EndpointDef } from '../contract/define';
import { CLIENT_ERROR_CODES, isStitchErrorCode } from '../contract/errors';
import { ApiError } from './api-error';

const CLIENT_CODES = new Set<string>(CLIENT_ERROR_CODES);

export function readOperationRefusal(
  endpoint: EndpointDef,
  error: unknown,
): ApiError | undefined {
  if (!ApiError.is(error)) return undefined;
  const declared = endpoint.refuses?.find((refusal) => refusal.code === error.code);
  if (declared === undefined)
    return isStitchErrorCode(error.code) || CLIENT_CODES.has(error.code) ? error : undefined;
  const schema = declared.definition.details;
  if (schema === undefined) return error;
  return schema.safeParse(error.details).success ? error : undefined;
}
