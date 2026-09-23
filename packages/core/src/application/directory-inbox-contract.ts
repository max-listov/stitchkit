import { z } from 'zod';
import type { ManagedResource, ManagedResourceDependency } from './resource';
import type { StateStore } from './state-store';

/**
 * What the inbox remembers about the entries of its directory. The entries
 * themselves stay files; the state holds only what a restart must not forget —
 * which entry is taken (`claims`), which is done (`receipts`) and which was set
 * aside (`rejected`). Taken and done are separate records on purpose: a claim
 * without a receipt is work a crash may have cut short, and is taken again once
 * its lease runs out; a receipt is work that must never run again, even when the
 * process died before it removed the file.
 */
const timestamp = z.string().datetime({ offset: true });
const key = z.string().min(1).max(255);

export const DirectoryInboxRejectionReasonSchema = z.enum([
  'invalid',
  'too-large',
  'attempt-limit',
]);
export type DirectoryInboxRejectionReason = z.infer<
  typeof DirectoryInboxRejectionReasonSchema
>;

export const DirectoryInboxStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    claims: z.array(
      z
        .object({
          key,
          attempts: z.number().int().positive(),
          nextAttemptAt: timestamp,
          leaseId: z.string().min(1).max(128).nullable(),
          leaseUntil: timestamp.nullable(),
        })
        .strict(),
    ),
    receipts: z.array(z.object({ key, completedAt: timestamp }).strict()),
    rejected: z.array(
      z
        .object({
          key,
          reason: DirectoryInboxRejectionReasonSchema,
          detail: z.string().max(1_000),
          rejectedAt: timestamp,
        })
        .strict(),
    ),
  })
  .strict();
export type DirectoryInboxState = z.infer<typeof DirectoryInboxStateSchema>;
export type DirectoryInboxClaim = DirectoryInboxState['claims'][number];
export type DirectoryInboxRejection = DirectoryInboxState['rejected'][number];

export const emptyDirectoryInboxState = (): DirectoryInboxState => ({
  schemaVersion: 1,
  claims: [],
  receipts: [],
  rejected: [],
});

/**
 * A directory another program drops entries into, handed to the application
 * at least once each. The producer writes each entry atomically as a
 * `<name>.json` file (a temporary name, then a rename); names starting with a
 * dot are never read, which is where the inbox keeps its own state.
 */
export interface DirectoryInboxDelivery<TEntry> {
  /** The entry's file name — stable across retries and restarts. */
  readonly key: string;
  readonly entry: TEntry;
  /** 1 on the first delivery of this entry. */
  readonly attempt: number;
  /** Aborted when the application is forced down mid-delivery. */
  readonly signal: AbortSignal;
}

export interface DirectoryInboxConfig<TEntry> {
  readonly id: string;
  readonly directory: string;
  readonly schema: z.ZodType<TEntry>;
  /** Throwing leaves the entry for a later attempt. */
  readonly handle: (delivery: DirectoryInboxDelivery<TEntry>) => void | Promise<void>;
  readonly dependsOn?: readonly ManagedResourceDependency[];
  /** Default: `<directory>/.inbox-state.json`, locked across processes. */
  readonly store?: StateStore<DirectoryInboxState>;
  readonly clock?: () => Date;
  /** How often the directory is read while the application runs. Default 1 s. */
  readonly pollIntervalMs?: number;
  /** How long a taken entry is someone's before it may be taken again. Default 5 min. */
  readonly leaseMs?: number;
  /** Deliveries of one entry before it is set aside. Default 20. */
  readonly maxAttempts?: number;
  /** Larger entries are set aside unread. Default 1 MiB. */
  readonly maxEntryBytes?: number;
  /** Receipts and rejections kept. Default 1 000. */
  readonly retain?: number;
  /** An entry was set aside into `<directory>/rejected/`, with the reason. */
  readonly onRejected?: (rejection: DirectoryInboxRejection) => void | Promise<void>;
  /**
   * A delivery failed (the entry is retried after a backoff) or a whole pass
   * did (storage, the directory; the next poll tries again).
   */
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export interface DirectoryInbox {
  /** Deliver every entry due now; resolves with how many were handled. */
  flush(): Promise<number>;
  state(): Promise<DirectoryInboxState>;
}

export interface DirectoryInboxResource extends ManagedResource {
  start(): Promise<{ readonly value: DirectoryInbox }>;
}

/** What the next step does with one entry of the directory. */
export type InboxStep =
  | { readonly kind: 'skip' }
  | { readonly kind: 'remove' }
  | { readonly kind: 'set-aside' }
  | { readonly kind: 'reject'; readonly rejection: DirectoryInboxRejection }
  | { readonly kind: 'deliver'; readonly claim: DirectoryInboxClaim };

interface StepInput {
  readonly key: string;
  readonly now: Date;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retain: number;
}

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

export function withRejection(
  state: DirectoryInboxState,
  rejection: DirectoryInboxRejection,
  retain: number,
): DirectoryInboxState {
  return {
    ...state,
    claims: state.claims.filter((claim) => claim.key !== rejection.key),
    rejected: [
      rejection,
      ...state.rejected.filter((item) => item.key !== rejection.key),
    ].slice(0, retain),
  };
}

/**
 * Decide one entry, and take it when it is due. A claim whose attempts are
 * spent is not taken again: an entry whose handling kills the process would
 * otherwise be retried on every restart, forever.
 */
export function claimEntry(
  state: DirectoryInboxState,
  input: StepInput,
): { readonly state: DirectoryInboxState; readonly step: InboxStep } {
  if (state.receipts.some((receipt) => receipt.key === input.key)) {
    return { state, step: { kind: 'remove' } };
  }
  if (state.rejected.some((rejection) => rejection.key === input.key)) {
    return { state, step: { kind: 'set-aside' } };
  }
  const now = input.now.getTime();
  const claim = state.claims.find((candidate) => candidate.key === input.key);
  if (claim) {
    const leased = claim.leaseUntil !== null && Date.parse(claim.leaseUntil) > now;
    if (leased || Date.parse(claim.nextAttemptAt) > now)
      return { state, step: { kind: 'skip' } };
    if (claim.attempts >= input.maxAttempts) {
      const rejection: DirectoryInboxRejection = {
        key: input.key,
        reason: 'attempt-limit',
        detail: `taken ${claim.attempts} times without completing`,
        rejectedAt: iso(now),
      };
      return {
        state: withRejection(state, rejection, input.retain),
        step: { kind: 'reject', rejection },
      };
    }
  }
  const taken: DirectoryInboxClaim = {
    key: input.key,
    attempts: (claim?.attempts ?? 0) + 1,
    nextAttemptAt: iso(now),
    leaseId: crypto.randomUUID(),
    leaseUntil: iso(now + input.leaseMs),
  };
  return {
    state: {
      ...state,
      claims: [...state.claims.filter((candidate) => candidate.key !== input.key), taken],
    },
    step: { kind: 'deliver', claim: taken },
  };
}

/** The entry was handled: its receipt replaces its claim. */
export function completeEntry(
  state: DirectoryInboxState,
  entryKey: string,
  now: Date,
  retain: number,
): DirectoryInboxState {
  return {
    ...state,
    claims: state.claims.filter((claim) => claim.key !== entryKey),
    receipts: [
      { key: entryKey, completedAt: now.toISOString() },
      ...state.receipts.filter((receipt) => receipt.key !== entryKey),
    ].slice(0, retain),
  };
}

/** The handler refused: wait, then take it again — unless it is no longer ours. */
export function releaseEntry(
  state: DirectoryInboxState,
  claim: DirectoryInboxClaim,
  retryAt: Date,
): DirectoryInboxState {
  return {
    ...state,
    claims: state.claims.map((candidate) =>
      candidate.key === claim.key && candidate.leaseId === claim.leaseId
        ? {
            ...candidate,
            nextAttemptAt: retryAt.toISOString(),
            leaseId: null,
            leaseUntil: null,
          }
        : candidate,
    ),
  };
}

/** Records about entries that are gone from the directory, except a live lease. */
export function forgetMissing(
  state: DirectoryInboxState,
  present: ReadonlySet<string>,
  now: Date,
): DirectoryInboxState {
  const live = (claim: DirectoryInboxClaim) =>
    claim.leaseUntil !== null && Date.parse(claim.leaseUntil) > now.getTime();
  return {
    ...state,
    claims: state.claims.filter((claim) => present.has(claim.key) || live(claim)),
  };
}
