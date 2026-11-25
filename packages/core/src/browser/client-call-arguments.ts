/**
 * What a client method was called with, read before anything is sent: the
 * arguments object, the options bag of `withOptions`, and the argument count
 * that a call site without types can get wrong.
 */
import type { ClientRequestOptions } from '../contract/client-types';
import type { EndpointDef } from '../contract/define';
import { isRecord } from '../internal/typed';

/**
 * `withOptions` takes one argument for an endpoint with no input and two for an
 * endpoint that has one, and calling the wrong shape used to be silent: the
 * extra argument was dropped, the request went out **uncancelled**, and the
 * caller still saw `REQUEST_ABORTED` because the cancellation wrapper reads the
 * signal it was handed regardless. The server then ran the operation to its own
 * deadline. That reads as "cancellation does not work over this transport" and
 * costs a transport investigation; it was reported as one, and reproduced by
 * four separate mis-calls of this method while the report was being chased.
 *
 * TypeScript refuses the wrong arity at a typed call site, which is why this
 * went unguarded — but the reports come from call sites that are not typed:
 * generated wrappers, dynamic dispatch, JavaScript.
 *
 * The count is read, never the value. `arguments.length` cannot trip a getter,
 * so this stays compatible with the rule that a client method must survive being
 * handed a foreign callback context (`client-cancellation.test.ts`). That rule
 * is about the bare callable — `api.op` passed to `map` — and a throwing getter
 * in argument two is exactly why the guard must not look at what it counts.
 */
export function refuseExtraWithOptionsArguments(
  endpoint: EndpointDef,
  received: number,
  expected: 1 | 2,
): void {
  if (received <= expected) return;
  const shape = expected === 1 ? 'withOptions(options)' : 'withOptions(args, options)';
  throw new TypeError(
    `${endpoint.method} ${endpoint.path}: this endpoint declares ${
      expected === 1 ? 'no input' : 'an input'
    }, so its method is ${shape} — it received ${received} arguments. ` +
      'An extra argument here is dropped, and a request options object in the dropped position ' +
      'sends the request without them: an abort signal placed there never reaches the server.',
  );
}

export function readClientRequestArgs(requestArgs: unknown): Record<string, unknown> {
  if (requestArgs !== undefined && !isRecord(requestArgs)) {
    throw new TypeError('Endpoint arguments must be an object');
  }
  return requestArgs ?? {};
}

export function readClientRequestOptions(
  endpoint: EndpointDef,
  value: unknown,
): ClientRequestOptions {
  if (!isRecord(value)) throw new TypeError('Client request options must be an object');
  const { signal, onUploadProgress } = value;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError('Client request signal must be an AbortSignal');
  }
  if (onUploadProgress === undefined) return signal === undefined ? {} : { signal };
  if (typeof onUploadProgress !== 'function') {
    throw new TypeError('Client request onUploadProgress must be a function');
  }
  if (!endpointSendsBody(endpoint)) {
    throw new TypeError(
      `${endpoint.method} ${endpoint.path}: onUploadProgress needs a request body — ` +
        'a GET, HEAD or DELETE sends none, and a streaming endpoint keeps its response live, ' +
        'which the XMLHttpRequest route would buffer.',
    );
  }
  return {
    ...(signal !== undefined && { signal }),
    onUploadProgress: (progress) => {
      onUploadProgress(progress);
    },
  };
}

function endpointSendsBody(endpoint: EndpointDef): boolean {
  return (
    endpoint.method !== 'GET' &&
    endpoint.method !== 'HEAD' &&
    endpoint.method !== 'DELETE' &&
    !('stream' in endpoint && endpoint.stream)
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof value.aborted === 'boolean' &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'removeEventListener' in value &&
    typeof value.removeEventListener === 'function'
  );
}
