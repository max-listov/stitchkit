import { AppError } from '../../contract/errors';

/**
 * The protocol by which an error class chooses how it crosses the tool boundary.
 * An error carrying this method is projected through it — its public form is
 * decided by the part that owns the class — while the tool runner keeps the
 * thrown value itself as the raw cause. `Symbol.for` makes it one key across
 * bundled copies of the framework.
 */
export const TOOL_ERROR_PROJECTION: unique symbol = Symbol.for(
  'stitchkit.toolErrorProjection',
);

/** An error that projects itself to the safe `AppError` a tool caller receives. */
export interface ToolErrorProjection {
  [TOOL_ERROR_PROJECTION](): AppError;
}

/** The safe projection a thrown value declares for itself, if it declares one. */
export function projectedToolError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const project: unknown = Reflect.get(error, TOOL_ERROR_PROJECTION);
  if (typeof project !== 'function') return undefined;
  const projected: unknown = Reflect.apply(project, error, []);
  return AppError.is(projected) ? projected : undefined;
}
