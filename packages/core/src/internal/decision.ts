import { z } from 'zod';

/**
 * One answer to "may this happen?", from one answerer.
 *
 * Three outcomes and no fourth, because the third is the one that gets left out
 * and then invented: `defer` means *not my call*, which is a different statement
 * from `allow`. Collapsing them makes every answerer that had no opinion into an
 * answerer that approved, and nothing in the result says which happened.
 *
 * `deny` carries its reason as a required field. A refusal without one reaches a
 * human as "denied" and sends them to read the policy source to find out what
 * they did, which is the moment a policy engine stops being worth having.
 *
 * Browser-safe and shared on purpose: an event listener voting on a topic
 * (`stitchkit/live`) and a policy in an ordered pipeline
 * (`stitchkit/application`) are different mechanisms answering the same
 * question, and one question with two vocabularies is a codebase where `grep`
 * finds half the answerers.
 */
export const PolicyDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('allow') }).strict(),
  z.object({ outcome: z.literal('deny'), reason: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal('defer') }).strict(),
]);

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** What is concluded when nobody claimed the question — see each mechanism for which it uses. */
export type UndecidedOutcome = 'allow' | 'deny';
