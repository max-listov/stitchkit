import type { ZodType } from 'zod';
import type { TransportSource } from '../../contract/define';
import { AppError } from '../../contract/errors';
import { validateDeclaredOutput } from '../../contract/normalize';
import type { EndpointToolView } from '../../contract/tool-view';
import { isRecord } from '../../internal/typed';

/** The schema a tool-surface answer is validated and advertised against. */
export function toolSurfaceOutputSchema(operation: {
  outputSchema?: ZodType;
  toolView?: EndpointToolView;
}): ZodType | undefined {
  // No full output, no view: the runner projects only a validated full result,
  // so advertising the view's schema there would describe an answer never sent.
  if (!operation.outputSchema) return undefined;
  return operation.toolView?.output ?? operation.outputSchema;
}

/**
 * Fill the keys a tool call did not pass with the view's defaults — before the
 * endpoint's own `input` parses them, so there is one parser and the handler
 * cannot tell a default from a value the model chose. A key the caller passed,
 * `null` included, is the caller's.
 */
export function applyToolViewDefaults(
  inputArgs: Record<string, unknown>,
  defaults: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!defaults) return inputArgs;
  const filled = { ...inputArgs };
  for (const [key, value] of Object.entries(defaults)) {
    // A fresh copy per call: a handler that mutates the array it was given
    // must not change the next call's default.
    if (filled[key] === undefined) filled[key] = structuredClone(value);
  }
  return filled;
}

/**
 * Turn a validated full result into the tool answer: `project` when declared,
 * otherwise the full value, then validated against the view's schema.
 *
 * A throwing or asynchronous `project` is a server fault whatever it threw —
 * the handler already succeeded, so a `NOT_FOUND` escaping the projection would
 * tell the model something about the call that is not true.
 */
export function projectToolView(options: {
  view: EndpointToolView;
  fullSchema: ZodType;
  full: unknown;
  call: { input: unknown; source: TransportSource };
  operation: string;
  onStripped?: (paths: string[]) => void;
}): { ok: true; data: unknown } | { ok: false; message: string } {
  const { view } = options;
  let projected: unknown = options.full;
  if (view.project) {
    try {
      // `withToolView` typed the signature against this endpoint's schemas;
      // the stored shape is the loose one, and the value passed is exactly
      // the validated full result and parsed input that signature names.
      projected = Reflect.apply(view.project, undefined, [options.full, options.call]);
    } catch (error) {
      const failure = new AppError(
        'INTERNAL_SERVER_ERROR',
        `${options.operation} toolView.project threw`,
        500,
      );
      failure.cause = error;
      throw failure;
    }
    if (isRecord(projected) && typeof projected.then === 'function') {
      // Settle it before refusing it: an abandoned rejected Promise is an
      // unhandled rejection, which a runtime may answer by ending the process.
      Promise.resolve(projected).catch(() => undefined);
      throw new AppError(
        'INTERNAL_SERVER_ERROR',
        `${options.operation} toolView.project returned a Promise — it must be synchronous`,
        500,
      );
    }
    if (projected === undefined) {
      return {
        ok: false,
        message: `${options.operation} toolView.project returned undefined`,
      };
    }
  }
  const checked = validateDeclaredOutput(
    view.output ?? options.fullSchema,
    projected,
    // Slicing by the view's schema removes keys on purpose (ADR 0037 keeps the
    // diagnostic for removals nobody meant); what a projection returns beyond
    // its own schema is a bug in the projection.
    view.project ? options.onStripped : undefined,
  );
  if (!checked.ok) {
    return { ok: false, message: `${options.operation} toolView: ${checked.message}` };
  }
  return checked;
}
