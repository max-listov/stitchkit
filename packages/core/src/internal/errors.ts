import { type ZodType, z } from 'zod';
import { AppError } from '../contract';
import { isRecord } from './typed';

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

/** Cap on structured issues carried in a `VALIDATION_ERROR`'s `details`. */
const MAX_DETAIL_ISSUES = 20;

/**
 * The stable error code for a thrown value — `AppError.code`, `VALIDATION_ERROR`
 * for a `ZodError`, else `undefined`. Side-effect-free (unlike `normalizeError`,
 * it never logs): for access-log attribution on a path where the response is
 * produced elsewhere — a custom `onError` hook that returns its own `Response`.
 */
export function errorCode(err: unknown): string | undefined {
  if (AppError.is(err)) return err.code;
  if (err instanceof z.ZodError) return 'VALIDATION_ERROR';
  return undefined;
}

/**
 * The message a **server-side record** should carry for a failure — an audit
 * row, not a response.
 *
 * Normally the envelope's: it is truthful for an `AppError` or a `ZodError`, and
 * it is what the caller was told, so the record and the response agree. The
 * exception is the scrubbed one — an unexpected throw becomes
 * `INTERNAL_SERVER_ERROR` / "Internal server error", which tells a later reader
 * nothing at all, and there the raw message goes in instead.
 *
 * The line this holds is not "the framework never touches a raw message" but
 * **"a raw message never crosses to the caller"**. Shared by the HTTP and tool
 * paths so that line is one rule in one place. → ADR 0042.
 */
export function recordedErrorMessage(
  code: string,
  envelopeMessage: string | undefined,
  thrown: unknown,
): string | undefined {
  // Both codes scrub the caller-facing envelope, so the record must take the
  // raw message instead — for a realtime violation that is the line naming the
  // event, direction and phase.
  if (
    (code === 'INTERNAL_SERVER_ERROR' || code === 'REALTIME_CONTRACT_VIOLATION') &&
    thrown !== undefined
  ) {
    if (thrown instanceof Error) return thrown.message;
    if (typeof thrown === 'string') return thrown;
  }
  return envelopeMessage;
}

export function normalizeError(err: unknown): AppError {
  if (AppError.is(err)) {
    // A realtime contract violation is a SERVER bug whose details — event
    // name, direction, field paths — are internal shape. Scrub them before
    // they cross to the caller; the full message still reaches observability
    // through `recordedErrorMessage`, which receives the raw thrown error.
    if (err.code === 'REALTIME_CONTRACT_VIOLATION') {
      return new AppError('REALTIME_CONTRACT_VIOLATION', 'Realtime contract violation', 500);
    }
    return err;
  }

  if (err instanceof z.ZodError) {
    // Carry structured field issues in `details` alongside the text `message`,
    // so a machine client matches on fields instead of parsing the message.
    return new AppError('VALIDATION_ERROR', formatZodError(err), 400, {
      issues: zodIssues(err).slice(0, MAX_DETAIL_ISSUES),
    });
  }

  // An unexpected error: log the real cause server-side, but return a generic
  // message to the caller — a raw `Error.message` can carry internal detail
  // (a DB connection string, a file path, a stack fragment).
  console.error('[stitchkit] unhandled error:', err);
  return new AppError('INTERNAL_SERVER_ERROR', 'Internal server error', 500);
}

/**
 * Every key present before validation and absent after it, as dot-paths.
 *
 * Deep on purpose: a field trimmed three levels down is exactly what a top-level
 * comparison misses, and a half-answer sends someone hunting the wrong endpoint.
 * Arrays are walked by index; a `.loose()` / `.catchall()` schema keeps its
 * extras, so it reports nothing.
 */
function strippedPaths(before: unknown, after: unknown, prefix: string): string[] {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return [];
    return before.flatMap((item, i) => strippedPaths(item, after[i], `${prefix}[${i}]`));
  }
  if (!isRecord(before) || !isRecord(after)) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(before)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in after)) {
      paths.push(path);
      continue;
    }
    paths.push(...strippedPaths(value, after[key], path));
  }
  return paths;
}

/**
 * Validate a handler's return value against the contract `output` schema. A
 * mismatch is a **server** fault (the handler broke its own contract) — shared
 * by the HTTP and tool transports so both report it identically.
 *
 * `onStripped` is the migration diagnostic: a handler returning more than its
 * contract declares has the extra fields **deleted**, correctly but invisibly —
 * types cannot catch it (structural typing does not reject excess properties) and
 * nothing logs it. Pass a reporter to find out; omit it and nothing is computed.
 */
export function validateHandlerOutput(
  schema: ZodType,
  data: unknown,
  onStripped?: (paths: string[]) => void,
): { ok: true; data: unknown } | { ok: false; message: string } {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    // The diff runs ONLY when a diagnostic is attached — with the flag off there
    // is no walk and no cost on the response path. → ADR 0037.
    if (onStripped) {
      const paths = strippedPaths(data, parsed.data, '');
      if (paths.length > 0) onStripped(paths);
    }
    return { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    message: `Handler output does not match the contract: ${formatZodError(parsed.error)}`,
  };
}

/**
 * Enforce the presence or absence of a contract output before a transport
 * presents it. `null` is JSON data when a schema accepts it; `undefined` never
 * is. Without a schema, nullish returns mean "no result" and any other value is
 * an undeclared response.
 */
export function validateDeclaredOutput(
  schema: ZodType | undefined,
  data: unknown,
  onStripped?: (paths: string[]) => void,
): { ok: true; data: unknown } | { ok: false; message: string } {
  if (!schema) {
    if (data === undefined || data === null) return { ok: true, data };
    return {
      ok: false,
      message: 'Handler returned data but the contract declares no output',
    };
  }
  if (data === undefined) {
    return {
      ok: false,
      message: 'Handler returned undefined but the contract declares an output',
    };
  }
  return validateHandlerOutput(schema, data, onStripped);
}
