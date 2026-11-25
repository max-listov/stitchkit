import { posix } from 'node:path';
import { z } from 'zod';
import {
  loadDarwinBinding,
  requireDarwinServiceHostMethod,
} from '../../internal/darwin-binding';
import { errnoOf } from '../../internal/errno';
import {
  observeProcessInstance,
  type ProcessInstanceObservation,
  sameProcessInstance,
} from '../../internal/process-instance';
import { isProcessGoneError } from '../process-evidence';
import {
  canonicalizeMacosPath,
  createDefaultMacosCommandRunner,
  type MacosCommandRunner,
  macosPathKey,
  PS_PATH,
} from './runner';

const MAX_PID = 2 ** 31 - 1;
const DEFAULT_MAX_SUBTREE_PROCESSES = 1_024;
const PS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s*$/;

/** One `(pid, ppid)` row parsed from `/bin/ps -axo pid=,ppid=`. */
export interface PsProcessEntry {
  pid: number;
  ppid: number;
}

/**
 * Classification returned by {@link inspectResponsibleProcess}:
 * - `'attributed'`: responsible executable lies strictly inside `expectedBundlePath`;
 * - `'observed'`: responsible process resolved (no `expectedBundlePath` supplied);
 * - `'misattributed'`: responsible executable points outside `expectedBundlePath`;
 * - `'unavailable'`: process exited, PID was reused during inspection, or native lookup unavailable.
 */
export type MacosResponsibilityStatus =
  | 'attributed'
  | 'observed'
  | 'misattributed'
  | 'unavailable';

/** Reason explaining a non-attributed or unavailable {@link ResponsibleProcessInspection} result. */
export type MacosResponsibilityReason =
  | 'process-gone'
  | 'process-unobservable'
  | 'responsibility-unsupported'
  | 'responsibility-lookup-failed'
  | 'responsible-process-gone'
  | 'process-path-failed'
  | 'pid-reused'
  | 'bundle-mismatch'
  | 'process-table-failed';

/** Detailed TCC responsibility inspection outcome for a single PID. */
export interface ResponsibleProcessInspection {
  status: MacosResponsibilityStatus;
  pid: number;
  responsiblePid: number | null;
  responsiblePath: string | null;
  expectedBundlePath: string | null;
  reason?: MacosResponsibilityReason;
  cause?: unknown;
}

/** Aggregated TCC responsibility verdict across a process subtree. */
export interface SubtreeResponsibilityVerification {
  status: 'attributed' | 'misattributed' | 'unavailable';
  rootPid: number;
  expectedBundlePath: string;
  checked: readonly ResponsibleProcessInspection[];
  misattributed: readonly ResponsibleProcessInspection[];
  unavailable: readonly ResponsibleProcessInspection[];
  gonePids: readonly number[];
}

/** Injectable host boundary for macOS TCC responsibility inspection. */
export interface MacosResponsibilityAdapter {
  responsiblePid(pid: number): Promise<number>;
  processPath(pid: number): Promise<string>;
  observeProcessInstance(pid: number): Promise<ProcessInstanceObservation>;
  canonicalizePath(targetPath: string): Promise<string>;
  listProcesses(): Promise<readonly PsProcessEntry[]>;
}

/** Options for {@link inspectResponsibleProcess}. */
export interface InspectResponsibleProcessOptions {
  pid: number;
  /** Expected owning `.app` bundle directory path (e.g. `/Users/example-user/Applications/Example.app`). */
  expectedBundlePath?: string;
  adapter?: MacosResponsibilityAdapter;
}

/** Options for {@link verifyProcessSubtreeResponsibility}. */
export interface VerifyProcessSubtreeResponsibilityOptions {
  rootPid: number;
  expectedBundlePath: string;
  /** Maximum number of processes allowed in the BFS subtree walk (default: 1,024). */
  maxProcesses?: number;
  adapter?: MacosResponsibilityAdapter;
}

/** Parse the stdout of `/bin/ps -axo pid=,ppid=` into `(pid, ppid)` records. */
export function parsePsPidPpidTable(stdout: string): PsProcessEntry[] {
  const entries: PsProcessEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const match = PS_LINE_PATTERN.exec(rawLine);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      pid <= MAX_PID &&
      Number.isSafeInteger(ppid) &&
      ppid >= 0 &&
      ppid <= MAX_PID
    ) {
      entries.push({ pid, ppid });
    }
  }
  return entries;
}

/**
 * Collect `rootPid` and all its descendants via BFS over a `(pid, ppid)` table,
 * guarding against parent cycles and enforcing `maxProcesses`.
 */
export function collectProcessSubtreePids(
  rootPid: number,
  entries: readonly PsProcessEntry[],
  options?: { maxProcesses?: number },
): number[] {
  z.number().int().positive().max(MAX_PID).parse(rootPid);
  const maxProcesses = options?.maxProcesses ?? DEFAULT_MAX_SUBTREE_PROCESSES;
  if (!Number.isSafeInteger(maxProcesses) || maxProcesses <= 0) {
    throw new RangeError(`Invalid maxProcesses: ${maxProcesses}`);
  }

  const childrenByParent = new Map<number, number[]>();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.ppid);
    if (children === undefined) {
      childrenByParent.set(entry.ppid, [entry.pid]);
    } else {
      children.push(entry.pid);
    }
  }

  const visited = new Set<number>([rootPid]);
  const ordered: number[] = [rootPid];
  let cursor = 0;

  while (cursor < ordered.length) {
    const current = ordered[cursor];
    cursor += 1;
    if (current === undefined) break;
    const children = childrenByParent.get(current);
    if (children === undefined) continue;
    for (const childPid of children) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      ordered.push(childPid);
      if (ordered.length > maxProcesses) {
        throw new RangeError(
          `Process subtree rooted at ${rootPid} exceeded maxProcesses (${maxProcesses})`,
        );
      }
    }
  }

  return ordered;
}

/**
 * Return `true` iff a canonical executable path lies strictly inside a
 * canonical `.app` bundle (`<bundlePath>/Contents/...`), defeating prefix
 * confusion attacks such as `/Applications/Example.app2/Contents/MacOS/evil`.
 */
export function isExecutableInsideBundle(
  canonicalExecutablePath: string,
  canonicalBundlePath: string,
): boolean {
  if (
    canonicalExecutablePath.includes('\0') ||
    canonicalBundlePath.includes('\0') ||
    canonicalExecutablePath.split('/').includes('..') ||
    canonicalBundlePath.split('/').includes('..')
  ) {
    return false;
  }
  const cleanExe = posix.normalize(canonicalExecutablePath).replace(/\/+$/, '');
  const cleanBundle = posix.normalize(canonicalBundlePath).replace(/\/+$/, '');
  if (cleanBundle.length === 0 || !cleanExe.startsWith('/') || !cleanBundle.startsWith('/')) {
    return false;
  }
  return macosPathKey(cleanExe).startsWith(`${macosPathKey(cleanBundle)}/contents/`);
}

/** Create the default Darwin responsibility adapter backed by Darwin N-API and `/bin/ps`. */
export function createDefaultMacosResponsibilityAdapter(
  runner: MacosCommandRunner = createDefaultMacosCommandRunner(),
): MacosResponsibilityAdapter {
  return {
    async responsiblePid(pid) {
      const fn = requireDarwinServiceHostMethod(loadDarwinBinding(), 'responsiblePid');
      return fn(pid);
    },
    async processPath(pid) {
      const fn = requireDarwinServiceHostMethod(loadDarwinBinding(), 'processPath');
      return fn(pid);
    },
    observeProcessInstance,
    canonicalizePath: (targetPath) => canonicalizeMacosPath(targetPath),
    async listProcesses() {
      const result = await runner.runCommand(PS_PATH, ['-axo', 'pid=,ppid=']);
      if (result.exitCode !== 0) {
        throw new Error(`ps failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
      }
      return parsePsPidPpidTable(result.stdout);
    },
  };
}

function unavailableInspection(
  pid: number,
  expectedBundlePath: string | null,
  reason: MacosResponsibilityReason,
  extra?: { responsiblePid?: number | null; responsiblePath?: string | null; cause?: unknown },
): ResponsibleProcessInspection {
  return {
    status: 'unavailable',
    pid,
    responsiblePid: extra?.responsiblePid ?? null,
    responsiblePath: extra?.responsiblePath ?? null,
    expectedBundlePath,
    reason,
    ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
  };
}

/**
 * Whether a lookup that failed without an errno failed because `pid` is gone — asked of the
 * process table, never assumed: a native call that reports no process and sets no errno says
 * nothing about why.
 */
async function goneAfterSilentFailure(
  adapter: MacosResponsibilityAdapter,
  pid: number,
  cause: unknown,
): Promise<boolean> {
  if (errnoOf(cause) !== undefined) return false;
  const observation = await adapter.observeProcessInstance(pid);
  return observation.state === 'unavailable' && isProcessGoneError(observation.cause);
}

/**
 * Inspect the macOS TCC responsible process for `pid` with a before/after
 * `observeProcessInstance` TOCTOU guard, path canonicalization (`/tmp` <->
 * `/private/tmp`), and strict `.app/Contents/` prefix verification.
 */
export async function inspectResponsibleProcess(
  options: InspectResponsibleProcessOptions,
): Promise<ResponsibleProcessInspection> {
  const pid = z.number().int().positive().max(MAX_PID).parse(options.pid);
  const adapter = options.adapter ?? createDefaultMacosResponsibilityAdapter();
  const expectedRaw = options.expectedBundlePath ?? null;

  const before = await adapter.observeProcessInstance(pid);
  if (before.state === 'unavailable') {
    const reason: MacosResponsibilityReason = isProcessGoneError(before.cause)
      ? 'process-gone'
      : 'process-unobservable';
    return unavailableInspection(pid, expectedRaw, reason, { cause: before.cause });
  }

  let respPid: number;
  try {
    respPid = await adapter.responsiblePid(pid);
  } catch (cause) {
    const code = errnoOf(cause);
    const reason: MacosResponsibilityReason =
      code === 'ESRCH' || (await goneAfterSilentFailure(adapter, pid, cause))
        ? 'process-gone'
        : code === 'EOPNOTSUPP'
          ? 'responsibility-unsupported'
          : 'responsibility-lookup-failed';
    return unavailableInspection(pid, expectedRaw, reason, { cause });
  }

  let respPath: string;
  try {
    respPath = await adapter.processPath(respPid);
  } catch (cause) {
    const reason: MacosResponsibilityReason =
      isProcessGoneError(cause) || (await goneAfterSilentFailure(adapter, respPid, cause))
        ? 'responsible-process-gone'
        : 'process-path-failed';
    return unavailableInspection(pid, expectedRaw, reason, { responsiblePid: respPid, cause });
  }

  const after = await adapter.observeProcessInstance(pid);
  if (after.state === 'unavailable') {
    const reason: MacosResponsibilityReason = isProcessGoneError(after.cause)
      ? 'process-gone'
      : 'process-unobservable';
    return unavailableInspection(pid, expectedRaw, reason, {
      responsiblePid: respPid,
      responsiblePath: respPath,
      cause: after.cause,
    });
  }
  if (!sameProcessInstance(before.instance, after.instance)) {
    return unavailableInspection(pid, expectedRaw, 'pid-reused', {
      responsiblePid: respPid,
      responsiblePath: respPath,
    });
  }

  const canonicalRespPath = await adapter.canonicalizePath(respPath);
  if (expectedRaw === null) {
    return {
      status: 'observed',
      pid,
      responsiblePid: respPid,
      responsiblePath: canonicalRespPath,
      expectedBundlePath: null,
    };
  }

  const canonicalExpectedBundle = await adapter.canonicalizePath(expectedRaw);
  if (isExecutableInsideBundle(canonicalRespPath, canonicalExpectedBundle)) {
    return {
      status: 'attributed',
      pid,
      responsiblePid: respPid,
      responsiblePath: canonicalRespPath,
      expectedBundlePath: canonicalExpectedBundle,
    };
  }

  return {
    status: 'misattributed',
    pid,
    responsiblePid: respPid,
    responsiblePath: canonicalRespPath,
    expectedBundlePath: canonicalExpectedBundle,
    reason: 'bundle-mismatch',
  };
}

/**
 * Verify that `rootPid` and every live descendant in its process subtree are
 * TCC-attributed to `expectedBundlePath`. Ephemeral children that exit during
 * traversal are recorded in `gonePids` rather than failing the subtree verdict.
 */
export async function verifyProcessSubtreeResponsibility(
  options: VerifyProcessSubtreeResponsibilityOptions,
): Promise<SubtreeResponsibilityVerification> {
  const rootPid = z.number().int().positive().max(MAX_PID).parse(options.rootPid);
  const adapter = options.adapter ?? createDefaultMacosResponsibilityAdapter();
  const canonicalExpectedBundle = await adapter.canonicalizePath(options.expectedBundlePath);

  let entries: readonly PsProcessEntry[];
  try {
    entries = await adapter.listProcesses();
  } catch (cause) {
    return {
      status: 'unavailable',
      rootPid,
      expectedBundlePath: canonicalExpectedBundle,
      checked: [],
      misattributed: [],
      unavailable: [
        {
          status: 'unavailable',
          pid: rootPid,
          responsiblePid: null,
          responsiblePath: null,
          expectedBundlePath: canonicalExpectedBundle,
          reason: 'process-table-failed',
          cause,
        },
      ],
      gonePids: [],
    };
  }

  const pids = collectProcessSubtreePids(rootPid, entries, {
    maxProcesses: options.maxProcesses,
  });

  const checked: ResponsibleProcessInspection[] = [];
  const misattributed: ResponsibleProcessInspection[] = [];
  const unavailable: ResponsibleProcessInspection[] = [];
  const gonePids: number[] = [];

  for (const pid of pids) {
    const inspection = await inspectResponsibleProcess({
      pid,
      expectedBundlePath: canonicalExpectedBundle,
      adapter,
    });
    if (
      inspection.status === 'unavailable' &&
      pid !== rootPid &&
      inspection.reason === 'process-gone'
    ) {
      gonePids.push(pid);
      continue;
    }
    checked.push(inspection);
    if (inspection.status === 'misattributed') misattributed.push(inspection);
    else if (inspection.status === 'unavailable') unavailable.push(inspection);
  }

  const status: SubtreeResponsibilityVerification['status'] =
    misattributed.length > 0
      ? 'misattributed'
      : unavailable.length > 0
        ? 'unavailable'
        : 'attributed';

  return {
    status,
    rootPid,
    expectedBundlePath: canonicalExpectedBundle,
    checked,
    misattributed,
    unavailable,
    gonePids,
  };
}
