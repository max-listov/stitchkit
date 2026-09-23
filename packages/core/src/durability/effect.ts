/**
 * An effect in another system, performed at most once.
 *
 * The rule a consumer had written by hand seven times, and one copy of which
 * had drifted: record the intent BEFORE the effect; record what the recipient
 * named it after; an intent found without an outcome is settled only by the
 * recipient's own record — found is `accepted`, not found is `uncertain` — and
 * `uncertain` is never retried. The copy that drifted wrote nothing before a
 * permission reply, so a lost acknowledgement sent the reply twice.
 */
import type { z } from 'zod';
import {
  DURABILITY_EFFECT_EVENT_KIND,
  type EffectHandlers,
  type EffectOutcome,
  type EffectRunOptions,
  EffectUnresolvedError,
  StepAbortedError,
  type StepDurabilityLedger,
} from './contract';
import { type DurabilityLedgerView, effectKey, encodeStepResult } from './ledger';

const DEFAULT_RECONCILE_TIMEOUT_MS = 30_000;
/** A proof is an identity the recipient assigned, not a payload. */
const MAX_PROOF_BYTES = 64 * 1024;

export interface EffectLedgerContext {
  readonly store: StepDurabilityLedger;
  readonly conversationId: string;
  readonly runId: string;
  readonly signal: AbortSignal | undefined;
  readLedger(): Promise<DurabilityLedgerView>;
}

type Proof = z.infer<ReturnType<typeof z.json>>;

function encodeProof(name: string, proof: unknown): string {
  let encoded: string;
  try {
    encoded = encodeStepResult(name, proof);
  } catch (cause) {
    throw new EffectUnresolvedError(name, 'proof-rejected', { cause });
  }
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MAX_PROOF_BYTES) {
    throw new EffectUnresolvedError(name, 'proof-rejected', {
      cause: new RangeError(
        `the proof is ${bytes} bytes; at most ${MAX_PROOF_BYTES} are kept`,
      ),
    });
  }
  return encoded;
}

function outcomeOf<P>(encoded: string): EffectOutcome<P> {
  // The lossless codec proves the JSON value; P belongs to this named effect's boundary.
  return { outcome: 'accepted', proof: JSON.parse(encoded) as P };
}

async function append(
  context: EffectLedgerContext,
  payload:
    | { phase: 'intent' }
    | { phase: 'uncertain' }
    | { phase: 'accepted'; encoded: string; via: 'run' | 'reconcile' },
  name: string,
): Promise<void> {
  await context.store.appendEvent({
    conversationId: context.conversationId,
    kind: DURABILITY_EFFECT_EVENT_KIND,
    payload: { runId: context.runId, effectName: name, ...payload },
  });
}

/** Ask the recipient, within the deadline, and record whatever it answers. */
async function reconcile<P extends Proof>(
  context: EffectLedgerContext,
  name: string,
  handlers: EffectHandlers<P>,
  timeoutMs: number,
): Promise<EffectOutcome<P>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`reconcile did not finish within ${timeoutMs} ms`));
      resolve('timeout');
    }, timeoutMs);
  });
  let found: P | null | 'timeout';
  try {
    found = await Promise.race([
      Promise.resolve().then(() => handlers.reconcile(controller.signal)),
      deadline,
    ]);
  } catch (cause) {
    throw new EffectUnresolvedError(name, 'reconcile-failed', { cause });
  } finally {
    clearTimeout(timer);
  }
  // Could not ask is not "not there": an overrun leaves the intent to be
  // reconciled again rather than recording an answer nobody gave.
  if (found === 'timeout') {
    throw new EffectUnresolvedError(name, 'reconcile-timeout', {
      cause: controller.signal.reason,
    });
  }
  if (found === null) {
    await append(context, { phase: 'uncertain' }, name);
    return { outcome: 'uncertain' };
  }
  const encoded = encodeProof(name, found);
  await append(context, { phase: 'accepted', encoded, via: 'reconcile' }, name);
  return outcomeOf<P>(encoded);
}

export async function executeEffect<P extends Proof>(
  context: EffectLedgerContext,
  name: string,
  handlers: EffectHandlers<P>,
  options: EffectRunOptions | undefined,
): Promise<EffectOutcome<P>> {
  const timeoutMs = options?.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      `reconcileTimeoutMs must be a positive finite number, got ${timeoutMs}`,
    );
  }
  const key = effectKey(context.conversationId, context.runId, name);
  const recorded = (await context.readLedger()).effects.get(key);
  if (recorded?.outcome === 'uncertain') return { outcome: 'uncertain' };
  if (recorded?.outcome === 'accepted') {
    return outcomeOf<P>(JSON.stringify(recorded.proof));
  }
  if (options?.signal?.aborted || context.signal?.aborted) throw new StepAbortedError(name);
  if (recorded) return reconcile(context, name, handlers, timeoutMs);

  await append(context, { phase: 'intent' }, name);
  let proof: P;
  try {
    proof = await handlers.run();
  } catch (cause) {
    throw new EffectUnresolvedError(name, 'run-failed', { cause });
  }
  const encoded = encodeProof(name, proof);
  await append(context, { phase: 'accepted', encoded, via: 'run' }, name);
  return outcomeOf<P>(encoded);
}
