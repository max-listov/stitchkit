/** Deterministic synchronization gate pausing replay execution at named labels without timers. */
export interface ReplayGate {
  beforeEmit(label: string, signal?: AbortSignal): Promise<void>;
  waitForReached(label: string): Promise<boolean>;
  hasReached(label: string): boolean;
  release(label: string): boolean;
  releaseAll(): void;
}

interface GateSlot {
  reached: boolean;
  released: boolean;
  readonly reachedPromise: Promise<void>;
  readonly resolveReached: () => void;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/**
 * Create a deterministic label gate for replay drivers; rejects empty or duplicate labels. A label
 * is compared without its surrounding whitespace, when the gate is created and on every lookup.
 */
export function createReplayGate(labels: readonly string[]): ReplayGate {
  const slots = new Map<string, GateSlot>();
  for (const rawLabel of labels) {
    const label = rawLabel.trim();
    if (label.length === 0) {
      throw new TypeError('Replay gate label must be a non-empty string');
    }
    if (slots.has(label)) {
      throw new TypeError(`Duplicate replay gate label "${label}"`);
    }
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    let resolveReached: () => void = () => undefined;
    const reachedPromise = new Promise<void>((done) => {
      resolveReached = done;
    });
    slots.set(label, {
      reached: false,
      released: false,
      reachedPromise,
      resolveReached,
      promise,
      resolve,
    });
  }

  const slotOf = (label: string) => slots.get(label.trim());

  return {
    beforeEmit(label, signal) {
      const slot = slotOf(label);
      if (slot === undefined) return Promise.resolve();
      slot.reached = true;
      slot.resolveReached();
      if (signal === undefined) return slot.promise;
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((done) => {
        const onAbort = () => done();
        signal.addEventListener('abort', onAbort, { once: true });
        void slot.promise.then(() => {
          signal.removeEventListener('abort', onAbort);
          done();
        });
      });
    },
    waitForReached(label) {
      const slot = slotOf(label);
      return slot === undefined
        ? Promise.resolve(false)
        : slot.reachedPromise.then(() => true);
    },
    hasReached: (label) => slotOf(label)?.reached ?? false,
    release(label) {
      const slot = slotOf(label);
      if (slot === undefined || slot.released) return false;
      slot.released = true;
      slot.resolve();
      return true;
    },
    releaseAll() {
      for (const slot of slots.values()) {
        if (slot.released) continue;
        slot.released = true;
        slot.resolve();
      }
    },
  };
}
