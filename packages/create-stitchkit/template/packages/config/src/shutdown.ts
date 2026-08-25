/**
 * The parts of a shutdown that are NOT the drain, as one number each.
 *
 * `terminationBudgetMs` adds these to a role's drain floor and refuses a
 * supervision policy that allows less. That only means something if each part
 * is really bounded — and cleanup was not: the drain has a deadline, but the
 * closes that run after it (an MCP session, a database pool) had none, so the
 * "budget" was an estimate wearing the shape of an upper bound, and a role
 * could still be killed mid-shutdown by a timeout the generator had approved.
 *
 * They live here rather than in the generator because two readers need them and
 * a number in two places is two numbers: the generator, which tells a
 * supervisor how long to wait, and the role itself, which must not take longer.
 */

/** After the drain deadline, how long a forced finish may take. */
export const FORCE_BUDGET_MS = 5_000;

/** After the server is done, how long the role's own closes may take. */
export const CLEANUP_BUDGET_MS = 5_000;
