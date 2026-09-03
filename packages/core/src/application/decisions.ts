/**
 * An ordered chain of named policies that reaches one verdict, and says how.
 *
 * The shape an application writes as a run of `if`s, or as middleware where the
 * decision is whether somebody called `next()`. Both fail the same way: what
 * actually decided is not recoverable afterwards. A forgotten `next()` reads as
 * a deliberate stop, an `if` that fell through reads as approval, and the log
 * says "denied" with no way to learn which rule said so.
 *
 * ## What this is not
 *
 * It is **not** `createEventBus(...).decide`, and the difference is worth
 * knowing because the vocabulary is deliberately the same one. That is a set of
 * anonymous listeners voting on an announcement: registration order, no names,
 * and "nobody claimed it" is a legitimate ending the topic declares in advance.
 * This is an ordered list of *identified* policies deciding one operation, where
 * every step is in the trace by name and nobody claiming it is a **defect** —
 * an operation nothing approved and nothing refused has not been decided, and
 * answering `allow` or `deny` there would be inventing the answer.
 *
 * → ADR 0155.
 */
import { withDeadline } from '../internal/deadline';
import { type PolicyDecision, PolicyDecisionSchema } from '../internal/decision';

export type { PolicyDecision } from '../internal/decision';
export { PolicyDecisionSchema } from '../internal/decision';

export interface DecisionPolicy<TInput> {
  /** Names this policy in the trace. Unique within a pipeline. */
  readonly id: string;
  decide(input: TInput): PolicyDecision | Promise<PolicyDecision>;
}

export interface DecisionTraceEntry {
  readonly id: string;
  readonly outcome: PolicyDecision['outcome'];
  /** Present exactly when the outcome is `deny`. */
  readonly reason?: string;
}

export interface DecisionResult {
  /**
   * Terminal by construction. `defer` cannot appear here: a pipeline that
   * reached its end with nobody claiming the question raises rather than
   * choosing one for it.
   */
  readonly outcome: 'allow' | 'deny';
  /** Present exactly when the outcome is `deny` — the deciding policy's own words. */
  readonly reason?: string;
  /**
   * Exactly the policies that ran, in the order they ran.
   *
   * Not the configured list: a terminal verdict stops the chain, and a trace
   * that listed the policies which never executed would be a record of intent
   * rather than of what happened.
   */
  readonly trace: readonly DecisionTraceEntry[];
}

export interface DecisionPipelineConfig {
  /**
   * How long one policy has to answer, in milliseconds. Required, with no
   * default.
   *
   * A default here would be a number nobody chose, applied to consumer code the
   * framework has never seen — and the failure it hides is the worst one: a
   * policy that never settles hangs every caller of the operation it guards,
   * with nothing in any log to say which policy. Declaring it is one line and
   * makes the hang impossible; guessing it for the caller only moves the guess
   * somewhere they cannot see. `defineEvents` requires `listenerTimeoutMs` for
   * the same reason.
   */
  readonly policyTimeoutMs: number;
}

export interface DecisionPipeline<TInput> {
  decide(input: TInput): Promise<DecisionResult>;
  /** The configured policy ids, in order. For a status surface, not for deciding. */
  readonly policyIds: readonly string[];
}

/**
 * Nobody claimed the question.
 *
 * A defect in the policy set rather than a runtime condition, which is why it
 * raises instead of returning: an operation that no policy allowed and no policy
 * refused has not been decided, and the caller has no honest way to proceed. The
 * trace comes with it, because "nothing decided" is only actionable once you can
 * see what ran.
 */
export class DecisionUndecidedError extends Error {
  readonly trace: readonly DecisionTraceEntry[];
  constructor(trace: readonly DecisionTraceEntry[]) {
    const ran = trace.length === 0 ? 'no policy ran' : trace.map((e) => e.id).join(' → ');
    super(
      `Decision pipeline reached its end with no terminal verdict (${ran}). A pipeline needs a policy that answers allow or deny.`,
    );
    this.name = 'DecisionUndecidedError';
    this.trace = trace;
  }
}

/**
 * A policy did not answer: it returned a non-decision, threw, or ran past its
 * deadline.
 *
 * All three are one error on purpose. They are indistinguishable to everything
 * downstream — the question is undecided and the policy set is at fault — and
 * splitting them would invite a caller to handle one and not the others, which
 * is how a broken policy quietly becomes a skipped policy. The trace comes with
 * it for the same reason `DecisionUndecidedError` carries one.
 */
export class DecisionPolicyError extends Error {
  readonly policyId: string;
  readonly trace: readonly DecisionTraceEntry[];
  constructor(policyId: string, detail: string, trace: readonly DecisionTraceEntry[] = []) {
    super(
      `Policy "${policyId}" did not answer (${detail}). A policy returns { outcome: "allow" | "deny" | "defer" } within its deadline, and a deny carries a reason.`,
    );
    this.name = 'DecisionPolicyError';
    this.policyId = policyId;
    this.trace = trace;
  }
}

/**
 * Build a pipeline from an ordered list of policies.
 *
 * Duplicate ids are refused here rather than at the first decision: two policies
 * under one name make the trace ambiguous exactly when it is being read to
 * explain a refusal, which is the worst moment to discover it.
 */
export function createDecisionPipeline<TInput>(
  policies: readonly DecisionPolicy<TInput>[],
  config: DecisionPipelineConfig,
): DecisionPipeline<TInput> {
  const { policyTimeoutMs } = config;
  if (!Number.isInteger(policyTimeoutMs) || policyTimeoutMs <= 0) {
    throw new Error(
      '[stitchkit] decision pipeline: policyTimeoutMs must be a positive integer number of milliseconds.',
    );
  }
  const seen = new Set<string>();
  for (const policy of policies) {
    if (policy.id.trim() === '') {
      throw new Error('[stitchkit] decision pipeline: a policy needs a non-empty id.');
    }
    if (seen.has(policy.id)) {
      throw new Error(
        `[stitchkit] decision pipeline: two policies share the id "${policy.id}". The trace names policies by id, and a duplicate makes it ambiguous exactly when it is read to explain a refusal.`,
      );
    }
    seen.add(policy.id);
  }

  return {
    policyIds: policies.map((policy) => policy.id),
    async decide(input) {
      const trace: DecisionTraceEntry[] = [];
      for (const policy of policies) {
        // A policy is consumer code, so all three ways it can fail to answer are
        // caught here rather than trusted: it can throw, it can never settle, and
        // it can return something that is not a decision. Uncaught, the first two
        // reach the caller as a raw exception and a hang — the two shapes a
        // decision pipeline exists to make impossible.
        let answer: unknown;
        try {
          const outcome = await withDeadline(policy.decide(input), policyTimeoutMs);
          if (!outcome.settled) {
            throw new DecisionPolicyError(
              policy.id,
              `did not answer within ${policyTimeoutMs}ms`,
              trace,
            );
          }
          answer = outcome.value;
        } catch (error) {
          if (error instanceof DecisionPolicyError) throw error;
          throw new DecisionPolicyError(
            policy.id,
            error instanceof Error ? `threw: ${error.message}` : 'threw',
            trace,
          );
        }
        const parsed = PolicyDecisionSchema.safeParse(answer);
        if (!parsed.success) {
          throw new DecisionPolicyError(
            policy.id,
            parsed.error.issues[0]?.message ?? 'invalid',
            trace,
          );
        }
        const decision = parsed.data;
        trace.push(
          decision.outcome === 'deny'
            ? { id: policy.id, outcome: 'deny', reason: decision.reason }
            : { id: policy.id, outcome: decision.outcome },
        );
        if (decision.outcome === 'deny') {
          return { outcome: 'deny', reason: decision.reason, trace };
        }
        if (decision.outcome === 'allow') {
          return { outcome: 'allow', trace };
        }
      }
      throw new DecisionUndecidedError(trace);
    },
  };
}
