/**
 * "Write the calls that changed something" — one filter, not six.
 *
 * Every project that audits eventually writes this predicate, and measured
 * across six sibling consumers they had written six different ones: one audited
 * only tool calls, one excluded `/mcp`, and two disagreed with each other on
 * `OPTIONS`. Nobody decided any of that. They each started from the one form the
 * `RequestEvent.httpMethod` doc gives — `(event.httpMethod ?? event.method) !==
 * 'GET'` — which is right about `GET` and silent about the other two verbs that
 * change nothing, and filled the gap from memory.
 *
 * That is the duplicated observability layer ADR 0012 exists to end, one level
 * further in: the module owns the machinery, the project owns the policy. A
 * predicate over a normalised event is machinery.
 *
 * ## The two rules, and why they are in this order
 *
 * **A security outcome is written whatever the verb was.** A rejected read is
 * the single most interesting row in an audit table — it is how an attempt to
 * reach something shows up at all — and a filter that drops every `GET` drops
 * exactly that. This rule is first because it is the one a hand-written filter
 * loses: the author is thinking about writes, and a refused read is not a write.
 *
 * **Then reads are dropped and everything else is kept.** Not "writes are kept":
 * an unknown verb is kept, because the failure modes are not symmetric. An extra
 * row costs bytes; a missing row costs the answer to "who changed this", and it
 * costs it silently and only later, when the question is finally asked.
 */
import type { RequestEvent } from './event';

/**
 * The verbs that do not change anything.
 *
 * `OPTIONS` is the one that divided the consumers, and it belongs here: a
 * preflight is a question about what would be allowed, asked by the browser
 * rather than by the user, and auditing it buries the calls that did something
 * under the calls that asked about doing something.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Statuses that are written whatever the verb was.
 *
 * `401` and `403` only. Not `404` — an audit of every missing path is an audit
 * of every typo and every stale bookmark, and it is not evidence of an attempt
 * to reach anything in particular. Not `429` either: a rate limit is a capacity
 * fact, and the calls it refused are already visible as the ones that got
 * through.
 */
const SECURITY_STATUSES = new Set([401, 403]);

/**
 * Whether this call is worth an audit row: it changed something, or it was
 * refused for a reason the audit exists to record.
 *
 * Hand it to a sink as its `filter`:
 *
 * ```ts
 * createObservability({
 *   request: { write: (event) => db.audit.create({ data: event }), filter: auditChanges },
 *   tools: { write: (event) => db.audit.create({ data: event }), filter: auditChanges },
 * });
 * ```
 *
 * One filter for both surfaces on purpose. A tool call carries its contract verb
 * in `httpMethod` while its `method` is the literal `TOOL` (→ ADR 0030), so the
 * same predicate reads a write the same way whether it arrived over HTTP, MCP or
 * an agent — which is what keeps one audit table queryable across all three.
 *
 * Narrower or wider policy stays the project's: compose it.
 *
 * ```ts
 * filter: (event) => auditChanges(event) && event.serviceName !== 'health',
 * ```
 */
export function auditChanges(event: RequestEvent): boolean {
  if (event.statusCode !== undefined && SECURITY_STATUSES.has(event.statusCode)) return true;
  const verb = event.httpMethod ?? event.method;
  // A unit of work with no transport has no verb to read, and the honest answer
  // to "did this change anything" is that we cannot tell from the row. Keeping
  // it is the safe half of that: an audit filter that drops what it did not
  // examine reports zero and looks identical to nothing having happened.
  if (verb === undefined) return true;
  return !READ_METHODS.has(verb.toUpperCase());
}
