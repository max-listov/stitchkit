import { badRequest } from '../contract/errors';
import { abortReason } from '../internal/abort-race';
import { readBoundedText } from '../internal/bounded-body';
import { assertPositiveSafeInteger } from '../internal/positive-integer';

/** Read UTF-8 request text, optionally stopping before a configured byte cap is exceeded. */
export async function readRequestText(req: Request, maxBytes?: number): Promise<string> {
  // A runtime may abort the Fetch Request before a delayed body read starts.
  // `req.text()` is then allowed to remain pending on a transport stream that
  // has already disappeared, so fail from the request's canonical reason first.
  if (req.signal.aborted) throw abortReason(req.signal);
  if (maxBytes === undefined) return req.text();
  assertPositiveSafeInteger('maxJsonBodyBytes', maxBytes, Error);

  const result = await readBoundedText(req, { maxBytes, signal: req.signal });
  if (result.kind === 'over-limit') badRequest(`JSON body exceeds the ${maxBytes}-byte limit`);
  return result.text;
}
