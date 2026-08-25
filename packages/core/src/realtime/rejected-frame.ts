/**
 * A rejection the SENDER can see.
 *
 * A frame that fails the receiver's schema used to be dropped where it landed:
 * the receiving side reported `onRejected` and the sending side learned
 * nothing at all — it waited out its deadline and reported a timeout. For a
 * distributed pair that is the worst diagnostic shape there is. The machines
 * are healthy, the sockets are up, and every request times out in both
 * directions at once, which reads as a network fault rather than as two peers
 * disagreeing about a contract.
 *
 * It also quietly removed the point of putting a protocol generation in the
 * envelope: the check ran, and its answer could not reach the only party able
 * to act on it. There is no deployment order in which two generations coexist
 * if neither can tell the other why it is being refused.
 *
 * So when a refused frame carries an acknowledgement callback — the one
 * back-channel that already exists — the refusal is sent through it. A
 * fire-and-forget event still has nowhere to answer; that boundary is real and
 * is documented rather than papered over.
 */

/**
 * The reserved key. Namespaced because it travels on the application's own
 * acknowledgement channel: this envelope is delivered INSTEAD of a value the
 * application's `ack` schema would accept, and the sender recognises it before
 * parsing. An application whose acknowledgement is an object carrying this
 * exact key would be ambiguous — hence a key nobody writes by accident.
 */
export const REALTIME_REJECTION_KEY = '@stitchkit/realtime-rejected';

/**
 * One field the peer refused, already flattened.
 *
 * `path` is dotted and tuple-aware: the first payload's `v` field is `'0.v'`,
 * because event arguments are a tuple. This is what replaces reading a
 * `ZodError`'s internals on the receiving end — three conditions about somebody
 * else's object shape, for a fact that is binary.
 */
export interface RealtimeRejectionIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * At most this many issues travel; a refusal is a signal, not a report.
 *
 * Applied on BOTH sides. On the reading side it bounds what a peer can make
 * this process hold; on the writing side it bounds what a peer can make this
 * process send — and that one matters more, because the number of issues is
 * chosen by whoever sent the bad frame.
 */
export const MAX_REJECTION_ISSUES = 20;

/**
 * What the sender is told: which event, why, and the issues if there were any.
 *
 * `reason` is a union of one today, and deliberately a union: `invalid-arguments`
 * is the only refusal that CAN be answered. An event the receiver's contract
 * does not contain has no listener at all, so there is nothing on that side to
 * answer with; a frame missing its acknowledgement callback has no channel by
 * definition. Both stay reported locally, and both are honest gaps rather than
 * reasons this envelope is never sent.
 */
export interface RealtimeRejectionReport {
  event: string;
  /**
   * Why the peer refused it. `invalid-arguments` is what this version sends and
   * the shape a protocol-generation mismatch takes.
   *
   * Typed as a string rather than as a closed union **on the wire**, because a
   * closed union is a mechanism that cannot version itself forward: a peer on a
   * later release refusing for a reason this one has never heard of would fail
   * recognition, fall through to the application's acknowledgement schema, and
   * surface as "the peer answered with something invalid" — the precise
   * mischaracterisation this envelope exists to prevent. An unknown reason is
   * still a refusal, and is reported as one.
   */
  reason: string;
  message: string;
  issues?: RealtimeRejectionIssue[];
}

export interface RealtimeRejectionEnvelope {
  [REALTIME_REJECTION_KEY]: RealtimeRejectionReport;
}

export function realtimeRejectionEnvelope(
  report: RealtimeRejectionReport,
): RealtimeRejectionEnvelope {
  return { [REALTIME_REJECTION_KEY]: report };
}

/** Whether an acknowledgement value is a peer's refusal rather than a value. */
export function asRealtimeRejection(value: unknown): RealtimeRejectionReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const report: unknown = Reflect.get(value, REALTIME_REJECTION_KEY);
  if (typeof report !== 'object' || report === null) return null;
  const event = Reflect.get(report, 'event');
  const reason = Reflect.get(report, 'reason');
  const message = Reflect.get(report, 'message');
  if (typeof event !== 'string' || typeof reason !== 'string' || typeof message !== 'string') {
    return null;
  }
  if (reason.length === 0) return null;
  // Parsed, not trusted. This arrives from the peer over the wire like any
  // other frame, and the fact that it describes a validation failure does not
  // make it exempt from being validated.
  const issues = parseIssues(Reflect.get(report, 'issues'));
  return { event, reason, message, ...(issues !== undefined && { issues }) };
}

function parseIssues(value: unknown): RealtimeRejectionIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: RealtimeRejectionIssue[] = [];
  for (const entry of value.slice(0, MAX_REJECTION_ISSUES)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const path = Reflect.get(entry, 'path');
    const code = Reflect.get(entry, 'code');
    const message = Reflect.get(entry, 'message');
    if (typeof path === 'string' && typeof code === 'string' && typeof message === 'string') {
      issues.push({ path, code, message });
    }
  }
  return issues.length > 0 ? issues : undefined;
}
