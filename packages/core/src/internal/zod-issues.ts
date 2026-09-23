import type { z } from 'zod';

/** The dotted path of a Zod issue — `(root)` for a top-level issue. */
function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length > 0 ? path.map(String).join('.') : '(root)';
}

/** One field-level validation issue — the structured sibling of `formatZodError`. */
export interface ZodIssueSummary {
  /** Dotted path to the offending field (`(root)` for a top-level issue). */
  path: string;
  /** Zod issue code (e.g. `invalid_type`, `too_small`). */
  code: string;
  /** Human-readable message for this field. */
  message: string;
  /**
   * 1-based index of the union branch that produced this issue, counted within
   * the nearest enclosing union. Absent when no union was involved.
   */
  branch?: number;
}

/**
 * How deep the descent into nested unions EXPANDS — how many levels contribute
 * their own addressable issues. A union of unions of unions is already past the
 * point where one issue per branch helps a reader, and the depth is what bounds
 * an otherwise quadratic expansion.
 *
 * It deliberately does not bound the *wording*. A union whose expansion stopped
 * here still gets a summary that names the deepest field it can reach, because
 * that summary is one string rather than a set of issues: `nodes.0.streams:
 * Invalid input` is the line a reader was looking for, and printing zod's bare
 * sentence on exactly that line spends the one useful slot saying nothing.
 * `deepestBranchReason` walks with its own budget for that reason.
 */
const MAX_UNION_DEPTH = 3;

/** How many branches a union's own summary line describes before it says "more". */
const MAX_DESCRIBED_BRANCHES = 5;

/**
 * The per-branch failures Zod attaches to an `invalid_union` issue, or
 * `undefined` when there are none.
 *
 * A discriminated union whose discriminator itself does not match reports
 * `invalid_union` with an EMPTY `errors` and a `message` that already names the
 * accepted values — nothing to descend into, and nothing to improve.
 */
function unionBranches(issue: z.core.$ZodIssue): readonly z.core.$ZodIssue[][] | undefined {
  const errors: unknown = Reflect.get(issue, 'errors');
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  if (!errors.every((branch) => Array.isArray(branch))) return undefined;
  return errors as readonly z.core.$ZodIssue[][];
}

/** The reason one union branch was rejected, at the deepest field it reached. */
interface BranchReason {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

/**
 * How far one branch got before it gave up — the deepest named field in it.
 *
 * Not `issues[0]`. When a branch fails inside a nested union — `z.json()` is
 * one, and so is any recursive schema — its first issue is that nested
 * `invalid_union`, whose path is the enclosing union's own path. Describing a
 * branch by it produces a line that repeats what the reader already knows and
 * names nothing. The deepest issue is the one that got closest to the field the
 * caller actually got wrong.
 */
function deepestBranchReason(
  issues: readonly z.core.$ZodIssue[],
  prefix: ReadonlyArray<PropertyKey>,
  budget: number,
): BranchReason | undefined {
  let deepest: BranchReason | undefined;
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    const nested = budget > 0 ? unionBranches(issue) : undefined;
    const candidates: BranchReason[] = nested
      ? nested
          .map((branch) => deepestBranchReason(branch, path, budget - 1))
          .filter((reason): reason is BranchReason => reason !== undefined)
      : [{ path, message: issue.message }];
    for (const candidate of candidates) {
      if (!deepest || candidate.path.length > deepest.path.length) deepest = candidate;
    }
  }
  return deepest;
}

/**
 * One line naming why each branch was rejected.
 *
 * This is the whole point of the descent. Zod's own message for a failed union
 * is the literal string `Invalid input` at path `(root)`: it says that nothing
 * matched, and nothing about what would have. A caller holding a stale idea of
 * the contract reads that as "the server is broken", because the refusal offers
 * no other reading.
 *
 * The branches described are the ones that got FURTHEST, not the first few.
 * A union of a value against several primitives rejects most branches on the
 * type of the whole value, at the union's own path — those lines are identical
 * to each other and say nothing, and taking the first five hands the reader
 * exactly them while the branch that descended into the real field is counted
 * as "...and N more". One consuming session spent an hour on that line.
 */
function unionSummary(
  branches: readonly z.core.$ZodIssue[][],
  prefix: ReadonlyArray<PropertyKey>,
): string {
  const reasons = branches.map((issues, index) => ({
    branch: index + 1,
    reason: deepestBranchReason(issues, prefix, MAX_UNION_DEPTH),
  }));
  // Stable within equal depth, so a union whose branches all fail at the same
  // level still reads in branch order.
  const ranked = [...reasons].sort(
    (a, b) => (b.reason?.path.length ?? -1) - (a.reason?.path.length ?? -1),
  );
  const described = ranked.slice(0, MAX_DESCRIBED_BRANCHES).map(({ branch, reason }) => {
    if (!reason) return `branch ${branch} reported no reason`;
    return `branch ${branch} at ${issuePath(reason.path)}: ${reason.message}`;
  });
  const rest = branches.length - described.length;
  const suffix = rest > 0 ? `; ...and ${rest} more branches` : '';
  return `No union branch matched — ${described.join('; ')}${suffix}`;
}

function collectIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: ReadonlyArray<PropertyKey>,
  branch: number | undefined,
  depth: number,
  into: ZodIssueSummary[],
): void {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    const branches = unionBranches(issue);
    into.push({
      path: issuePath(path),
      code: issue.code,
      // Summarised whether or not the branches are expanded below: the depth
      // limit bounds how many issues a nested union contributes, not whether
      // its own line is allowed to say anything.
      message: branches ? unionSummary(branches, path) : issue.message,
      ...(branch !== undefined && { branch }),
    });
    if (!branches || depth >= MAX_UNION_DEPTH) continue;
    branches.forEach((branchIssues, index) => {
      collectIssues(branchIssues, path, index + 1, depth + 1, into);
    });
  }
}

/**
 * Project a `ZodError` into structured, wire-safe field issues — path / code /
 * message (and a union branch, where one applies) — nothing server-internal.
 * For a machine client that matches on fields rather than parsing the text
 * `message`. Returns every issue; a caller that bounds response size slices it
 * (see `normalizeError`).
 *
 * A failed union contributes its own issue AND one issue per branch failure, so
 * the refusal names the branch and the path instead of only `(root)`.
 */
export function zodIssues(error: z.ZodError): ZodIssueSummary[] {
  const issues: ZodIssueSummary[] = [];
  collectIssues(error.issues, [], undefined, 0, issues);
  return issues;
}

/** How many issues the text projection prints before it says "more". */
const MAX_FORMATTED_ISSUES = 5;

/**
 * The text a person reads, which is a different job from the structured list.
 *
 * `zodIssues` keeps every branch failure, including the several that sit at the
 * union's own path — a machine addresses them by branch number and wants them
 * all. A reader gains nothing from the same path twice: the union's own line
 * already quotes those reasons, and each repeat costs one of the few lines the
 * cap allows. So the text keeps the first issue at each path and drops the
 * rest, which is what leaves room for the line naming the field.
 */
export function formatZodError(error: z.ZodError): string {
  const seen = new Set<string>();
  const all = zodIssues(error).filter((issue) => {
    if (seen.has(issue.path)) return false;
    seen.add(issue.path);
    return true;
  });
  const shown = all.slice(0, MAX_FORMATTED_ISSUES);
  const lines = shown.map((issue) => {
    const where =
      issue.branch === undefined ? issue.path : `${issue.path} (branch ${issue.branch})`;
    return `${where}: ${issue.message}`;
  });
  const suffix =
    all.length > shown.length ? `\n...and ${all.length - shown.length} more issues` : '';
  return lines.join('\n') + suffix;
}
