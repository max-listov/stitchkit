import { describe, expect, test } from 'bun:test';
import {
  createLiveStateController,
  type LiveStateEventDecision,
  type LiveStateSourceOpenInput,
  type LiveStateSourceOpenResult,
} from '../src/browser/live-state';

interface RevisionState {
  readonly revision: number;
  readonly values: readonly string[];
}

interface RevisionEvent {
  readonly revision: number;
  readonly value: string;
}

function applyRevision(
  state: RevisionState,
  event: RevisionEvent,
): LiveStateEventDecision<RevisionState> {
  if (event.revision <= state.revision) return { outcome: 'duplicate' };
  if (event.revision !== state.revision + 1) return { outcome: 'gap' };
  return {
    outcome: 'applied',
    state: { revision: event.revision, values: [...state.values, event.value] },
  };
}

function controllerFor(
  open: (
    input: LiveStateSourceOpenInput<RevisionEvent>,
  ) => Promise<LiveStateSourceOpenResult<RevisionState>>,
  bounds: { maxBufferedEvents: number; maxBufferedBytes: number } = {
    maxBufferedEvents: 8,
    maxBufferedBytes: 8,
  },
) {
  return createLiveStateController<RevisionState, RevisionEvent>({
    source: { open },
    applyEvent: applyRevision,
    ...bounds,
    sizeOfEvent: () => 1,
  });
}

describe('createLiveStateController', () => {
  test('buffers an event emitted inside open and applies it after the snapshot boundary', async () => {
    const controller = controllerFor(async ({ onEvent }) => {
      onEvent({ revision: 2, value: 'during-open' });
      return {
        snapshot: { revision: 1, values: ['snapshot'] },
        close: () => undefined,
      };
    });

    const snapshot = await controller.start();

    expect(snapshot).toMatchObject({
      phase: 'live',
      generation: 1,
      hasValue: true,
      receivedEvents: 1,
      appliedEvents: 1,
      bufferedEvents: 0,
      value: { revision: 2, values: ['snapshot', 'during-open'] },
    });
    expect(controller.getSnapshot()).toBe(snapshot);
    await controller.close();
  });

  test('ignores duplicates and fails closed on a gap without changing the last good state', async () => {
    let deliver: (event: RevisionEvent) => void = () => {
      throw new Error('source is not open');
    };
    let unavailable: () => void = () => {
      throw new Error('source is not open');
    };
    let sourceClosed = 0;
    const controller = controllerFor(async ({ onEvent, onUnavailable }) => {
      deliver = onEvent;
      unavailable = onUnavailable;
      return {
        snapshot: { revision: 3, values: ['snapshot'] },
        close: () => {
          sourceClosed += 1;
        },
      };
    });
    await controller.start();

    deliver({ revision: 3, value: 'duplicate' });
    deliver({ revision: 5, value: 'gap' });
    unavailable();
    deliver({ revision: 4, value: 'late-after-gap' });
    await Promise.resolve();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'resync-required',
      reason: 'gap',
      duplicateEvents: 1,
      gapEvents: 1,
      value: { revision: 3, values: ['snapshot'] },
    });
    expect(sourceClosed).toBe(1);
    await controller.close();
  });

  test('bounds pre-snapshot events and closes a source that resolves after overflow', async () => {
    const opened = Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>();
    let input: LiveStateSourceOpenInput<RevisionEvent> | undefined;
    let sourceClosed = 0;
    const controller = controllerFor(
      (candidate) => {
        input = candidate;
        return opened.promise;
      },
      { maxBufferedEvents: 1, maxBufferedBytes: 1 },
    );
    const starting = controller.start();
    await Promise.resolve();
    input?.onEvent({ revision: 1, value: 'first' });
    input?.onEvent({ revision: 2, value: 'overflow' });

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'resync-required',
      reason: 'buffer-overflow',
      bufferedEvents: 0,
      receivedEvents: 2,
      refusedEvents: 1,
    });
    expect(input?.signal.aborted).toBe(true);

    opened.resolve({
      snapshot: { revision: 0, values: [] },
      close: () => {
        sourceClosed += 1;
      },
    });
    await starting;
    await Bun.sleep(0);
    expect(sourceClosed).toBe(1);
    expect(controller.getSnapshot().hasValue).toBe(false);
    await controller.close();
  });

  test('fences a late opening generation after resync', async () => {
    const first = Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>();
    const second = Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>();
    const inputs: LiveStateSourceOpenInput<RevisionEvent>[] = [];
    let opened = 0;
    let firstClosed = 0;
    const controller = controllerFor((input) => {
      inputs.push(input);
      opened += 1;
      return opened === 1 ? first.promise : second.promise;
    });

    const firstStart = controller.start();
    const secondStart = controller.resync();
    second.resolve({
      snapshot: { revision: 10, values: ['new'] },
      close: () => undefined,
    });
    await secondStart;

    first.resolve({
      snapshot: { revision: 1, values: ['old'] },
      close: () => {
        firstClosed += 1;
      },
    });
    await firstStart;
    await Bun.sleep(0);
    inputs[0]?.onEvent({ revision: 2, value: 'late-old-event' });

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'live',
      generation: 2,
      value: { revision: 10, values: ['new'] },
    });
    expect(firstClosed).toBe(1);
    await controller.close();
  });

  test('reports source loss without retrying and resynchronizes only when asked', async () => {
    const inputs: LiveStateSourceOpenInput<RevisionEvent>[] = [];
    let revision = 1;
    const controller = controllerFor(async (input) => {
      inputs.push(input);
      const snapshot = { revision, values: [`snapshot-${revision}`] };
      revision += 1;
      return { snapshot, close: () => undefined };
    });
    await controller.start();
    inputs[0]?.onUnavailable();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      reason: 'source-unavailable',
      generation: 1,
      value: { revision: 1 },
    });
    expect(inputs).toHaveLength(1);

    await controller.resync();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'live',
      generation: 2,
      value: { revision: 2 },
    });
    await controller.close();
  });

  test('isolates subscriber failures and closes from an external abort signal', async () => {
    const abort = new AbortController();
    const subscriberFailure = Promise.withResolvers<string>();
    const controller = createLiveStateController<RevisionState, RevisionEvent>({
      source: {
        open: async () => ({
          snapshot: { revision: 1, values: [] },
          close: () => undefined,
        }),
      },
      applyEvent: applyRevision,
      maxBufferedEvents: 2,
      maxBufferedBytes: 2,
      sizeOfEvent: () => 1,
      signal: abort.signal,
      onSubscriberError: ({ error }) =>
        subscriberFailure.resolve(error instanceof Error ? error.message : String(error)),
    });
    controller.subscribe(() => {
      throw new Error('listener unavailable');
    });
    let asyncSubscriberCalls = 0;
    controller.subscribe(async () => {
      asyncSubscriberCalls += 1;
      await new Promise<void>(() => undefined);
    });

    await controller.start();
    expect(await subscriberFailure.promise).toBe('listener unavailable');
    expect(asyncSubscriberCalls).toBe(1);
    abort.abort();
    await Promise.resolve();
    expect(controller.getSnapshot().phase).toBe('closed');
  });

  test('fences non-cooperative source cleanup without holding controller settlement', async () => {
    const opened = Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>();
    const neverCloses = new Promise<void>(() => undefined);
    let openCalls = 0;
    const controller = controllerFor(() => {
      openCalls += 1;
      return opened.promise;
    });
    const starting = controller.start();

    await expect(controller.close()).resolves.toMatchObject({ phase: 'closed' });
    opened.resolve({
      snapshot: { revision: 1, values: ['late'] },
      close: () => neverCloses,
    });

    await expect(starting).resolves.toMatchObject({ phase: 'closed', hasValue: false });
    expect(controller.getSnapshot()).toMatchObject({ phase: 'closed', hasValue: false });
    expect(openCalls).toBe(1);
  });

  test('settles start when a non-cooperative source open ignores cancellation', async () => {
    const neverOpens = new Promise<LiveStateSourceOpenResult<RevisionState>>(() => undefined);
    let openCalls = 0;
    const controller = controllerFor(() => {
      openCalls += 1;
      return neverOpens;
    });
    const starting = controller.start();

    await Promise.resolve();
    const firstResync = controller.resync();
    await Promise.resolve();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(controller.resync()).resolves.toMatchObject({
        phase: 'unavailable',
        generation: 2,
        reason: 'controller-capacity',
      });
    }
    await expect(firstResync).resolves.toMatchObject({ phase: 'unavailable', generation: 2 });
    await expect(starting).resolves.toMatchObject({ phase: 'unavailable', generation: 2 });
    expect(openCalls).toBe(2);
    await expect(controller.close()).resolves.toMatchObject({ phase: 'closed' });
  });

  test('does not open a source after a synchronous opening subscriber closes the controller', async () => {
    let openCalls = 0;
    const controller = controllerFor(async () => {
      openCalls += 1;
      return { snapshot: { revision: 1, values: [] }, close: () => undefined };
    });
    controller.subscribe((snapshot) => {
      if (snapshot.phase === 'opening') void controller.close();
    });

    await expect(controller.start()).resolves.toMatchObject({ phase: 'closed' });
    expect(openCalls).toBe(0);
  });

  test('returns the replacement opening when a synchronous subscriber resyncs', async () => {
    const replacement = Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>();
    let openCalls = 0;
    const controller = controllerFor(() => {
      openCalls += 1;
      return replacement.promise;
    });
    controller.subscribe((snapshot) => {
      if (snapshot.phase === 'opening' && snapshot.generation === 1) {
        void controller.resync();
      }
    });

    const starting = controller.start();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'opening', generation: 2 });
    expect(openCalls).toBe(1);
    replacement.resolve({
      snapshot: { revision: 2, values: ['replacement'] },
      close: () => undefined,
    });
    await expect(starting).resolves.toMatchObject({
      phase: 'live',
      generation: 2,
      value: { revision: 2 },
    });
    await controller.close();
  });

  test('awaits replacement opening when a snapshot subscriber resyncs', async () => {
    const replacement = Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>();
    let openCalls = 0;
    const controller = controllerFor(async () => {
      openCalls += 1;
      if (openCalls === 1) {
        return {
          snapshot: { revision: 1, values: ['rejected-scope'] },
          close: () => undefined,
        };
      }
      return replacement.promise;
    });
    controller.subscribe((snapshot) => {
      if (
        snapshot.phase === 'opening' &&
        snapshot.hasValue &&
        snapshot.value &&
        snapshot.value.values[0] !== 'accepted-scope'
      ) {
        void controller.resync();
      }
    });

    const starting = controller.start();
    await Promise.resolve();
    let settled = false;
    void starting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    replacement.resolve({
      snapshot: { revision: 2, values: ['accepted-scope'] },
      close: () => undefined,
    });
    await expect(starting).resolves.toMatchObject({
      phase: 'live',
      generation: 2,
      value: { revision: 2, values: ['accepted-scope'] },
    });
    await controller.close();
  });

  test('honors another synchronous resync when a replacement snapshot is still rejected', async () => {
    let openCalls = 0;
    const controller = controllerFor(async () => {
      openCalls += 1;
      return {
        snapshot:
          openCalls < 3
            ? { revision: openCalls, values: [`rejected-scope-${openCalls}`] }
            : { revision: openCalls, values: ['accepted-scope'] },
        close: () => undefined,
      };
    });
    controller.subscribe((snapshot) => {
      if (
        snapshot.phase === 'opening' &&
        snapshot.hasValue &&
        snapshot.value &&
        snapshot.value.values[0] !== 'accepted-scope'
      ) {
        void controller.resync();
      }
    });

    await expect(controller.start()).resolves.toMatchObject({
      phase: 'live',
      generation: 3,
      value: { revision: 3, values: ['accepted-scope'] },
    });
    expect(openCalls).toBe(3);
    await controller.close();
  });

  test('does not commit a reducer decision after reentrant close retires its generation', async () => {
    let deliver: (event: RevisionEvent) => void = () => undefined;
    let controller: ReturnType<typeof controllerFor>;
    controller = createLiveStateController<RevisionState, RevisionEvent>({
      source: {
        open: async ({ onEvent }) => {
          deliver = onEvent;
          return {
            snapshot: { revision: 1, values: ['snapshot'] },
            close: () => undefined,
          };
        },
      },
      applyEvent: (state, event) => {
        void controller.close();
        return applyRevision(state, event);
      },
      maxBufferedEvents: 2,
      maxBufferedBytes: 2,
      sizeOfEvent: () => 1,
    });
    await controller.start();

    deliver({ revision: 2, value: 'must-not-commit' });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'closed',
      appliedEvents: 0,
      value: { revision: 1, values: ['snapshot'] },
    });
  });

  test('bounds non-cooperative source cleanup and publishes when resync capacity returns', async () => {
    const cleanups = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let openCalls = 0;
    let closeCalls = 0;
    const controller = controllerFor(async () => {
      const opened = openCalls;
      openCalls += 1;
      return {
        snapshot: { revision: opened, values: [`generation-${opened}`] },
        close: () => {
          closeCalls += 1;
          return cleanups[opened]?.promise;
        },
      };
    });

    await controller.start();
    await controller.resync();
    await expect(controller.resync()).resolves.toMatchObject({
      phase: 'unavailable',
      reason: 'controller-capacity',
      generation: 2,
    });
    for (let attempt = 0; attempt < 10; attempt += 1) await controller.resync();
    expect({ openCalls, closeCalls }).toEqual({ openCalls: 2, closeCalls: 2 });

    cleanups[0]?.resolve();
    await Bun.sleep(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'resync-required',
      reason: 'controller-capacity',
    });
    await expect(controller.resync()).resolves.toMatchObject({ phase: 'live', generation: 3 });
    cleanups[1]?.resolve();
    await controller.close();
  });

  test('keeps the combined source operation bound while late opens become cleanup', async () => {
    const opens = Array.from({ length: 3 }, () =>
      Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>(),
    );
    const closes = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    let openCalls = 0;
    let activeOpens = 0;
    let activeCloses = 0;
    let maximumOperations = 0;
    const measure = (): void => {
      maximumOperations = Math.max(maximumOperations, activeOpens + activeCloses);
    };
    const controller = controllerFor(async () => {
      const index = openCalls;
      openCalls += 1;
      activeOpens += 1;
      measure();
      const pendingOpen = opens[index];
      if (!pendingOpen) throw new Error(`Missing source open gate ${index}`);
      const opened = await pendingOpen.promise;
      activeOpens -= 1;
      return {
        ...opened,
        close: async () => {
          activeCloses += 1;
          measure();
          await closes[index]?.promise;
          activeCloses -= 1;
        },
      };
    });

    void controller.start();
    void controller.resync();
    await expect(controller.resync()).resolves.toMatchObject({
      phase: 'unavailable',
      reason: 'controller-capacity',
    });
    opens[0]?.resolve({
      snapshot: { revision: 1, values: ['late-one'] },
      close: () => undefined,
    });
    await Bun.sleep(0);
    closes[0]?.resolve();
    await Bun.sleep(0);
    expect(controller.getSnapshot().phase).toBe('resync-required');

    const third = controller.resync();
    opens[2]?.resolve({
      snapshot: { revision: 3, values: ['current'] },
      close: () => undefined,
    });
    await expect(third).resolves.toMatchObject({ phase: 'live', generation: 3 });
    opens[1]?.resolve({
      snapshot: { revision: 2, values: ['late-two'] },
      close: () => undefined,
    });
    await Bun.sleep(0);
    await expect(controller.resync()).resolves.toMatchObject({
      phase: 'unavailable',
      reason: 'controller-capacity',
    });
    expect(maximumOperations).toBeLessThanOrEqual(2);

    closes[1]?.resolve();
    closes[2]?.resolve();
    await controller.close();
  });

  test('transfers a settled open to cleanup before queued resync can consume its slot', async () => {
    const secondOpen = Promise.withResolvers<LiveStateSourceOpenResult<RevisionState>>();
    const neverOpens = new Promise<LiveStateSourceOpenResult<RevisionState>>(() => undefined);
    const neverCloses = new Promise<void>(() => undefined);
    let openCalls = 0;
    let activeOpens = 0;
    let activeCloses = 0;
    let maximumOperations = 0;
    const measure = (): void => {
      maximumOperations = Math.max(maximumOperations, activeOpens + activeCloses);
    };
    const controller = controllerFor(() => {
      const index = openCalls;
      openCalls += 1;
      activeOpens += 1;
      measure();
      if (index === 0) return neverOpens;
      return secondOpen.promise;
    });

    void controller.start();
    void controller.resync();
    activeOpens -= 1;
    secondOpen.resolve({
      snapshot: { revision: 2, values: ['second'] },
      close: () => {
        activeCloses += 1;
        measure();
        return neverCloses;
      },
    });
    const queuedResync = Promise.resolve().then(() => controller.resync());
    const secondQueuedResync = Promise.resolve().then(() => controller.resync());

    await expect(queuedResync).resolves.toMatchObject({
      phase: 'unavailable',
      generation: 2,
      reason: 'controller-capacity',
    });
    await expect(secondQueuedResync).resolves.toMatchObject({
      phase: 'unavailable',
      generation: 2,
      reason: 'controller-capacity',
    });
    await Bun.sleep(0);
    expect({ openCalls, maximumOperations }).toEqual({ openCalls: 2, maximumOperations: 2 });
    await controller.close();
  });
});
