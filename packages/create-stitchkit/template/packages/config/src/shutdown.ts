/**
 * The parts of a shutdown that are NOT the drain, as one number each.
 *
 * `terminationBudgetMs` adds these to a role's drain floor and refuses a
 * supervision policy that allows less. That only means something if each part
 * is really bounded: MCP and database closes share a cleanup deadline after the
 * drain. An unbounded close would turn the declared upper bound into an estimate
 * and let the supervisor kill a role before its shutdown ends.
 *
 * They live here rather than in the generator because two readers need them and
 * a number in two places is two numbers: the generator, which tells a
 * supervisor how long to wait, and the role itself, which must not take longer.
 */

/** After the drain deadline, how long a forced finish may take. */
export const FORCE_BUDGET_MS = 5_000;

/** After the server is done, how long the role's own closes may take. */
export const CLEANUP_BUDGET_MS = 5_000;
