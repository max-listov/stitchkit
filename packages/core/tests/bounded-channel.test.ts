import { describe, expect, test } from 'bun:test';
import {
  BoundedChannelReaderError,
  createBoundedChannel,
  createCreditWindow,
} from '../src/application/channel';

describe('bounded delivery channel', () => {
  test('ordered mode preserves order and refuses count/byte overflow explicitly', async () => {
    const channel = createBoundedChannel<{ key: string; body: string }>({
      policy: 'ordered',
      maxItems: 3,
      maxBytes: 8,
      sizeOf: (value) => value.body.length,
    });
    expect(channel.offer({ key: 'a', body: 'aa' })).toEqual({ outcome: 'queued' });
    expect(channel.offer({ key: 'b', body: 'bbb' })).toEqual({ outcome: 'queued' });
    expect(channel.offer({ key: 'c', body: 'ccc' })).toEqual({ outcome: 'queued' });
    expect(channel.offer({ key: 'd', body: 'd' })).toEqual({
      outcome: 'refused',
      reason: 'item-capacity',
    });
    expect(channel.offer({ key: 'huge', body: 'x'.repeat(9) })).toEqual({
      outcome: 'refused',
      reason: 'item-too-large',
    });
    channel.close();

    const received: string[] = [];
    for await (const value of channel) received.push(value.key);
    expect(received).toEqual(['a', 'b', 'c']);
    expect(channel.getSnapshot()).toMatchObject({
      state: 'closed',
      queuedItems: 0,
      queuedBytes: 0,
      delivered: 3,
      refused: 2,
    });
  });

  test('ordered byte capacity is independent of item capacity', () => {
    const channel = createBoundedChannel<string>({
      policy: 'ordered',
      maxItems: 10,
      maxBytes: 4,
      sizeOf: (value) => value.length,
    });
    expect(channel.offer('abc')).toEqual({ outcome: 'queued' });
    expect(channel.offer('de')).toEqual({ outcome: 'refused', reason: 'byte-capacity' });
    expect(channel.getSnapshot()).toMatchObject({ queuedItems: 1, queuedBytes: 3 });
  });

  test('latest mode retains exactly one pending replaceable value and reports coalescing', async () => {
    const channel = createBoundedChannel<{ revision: number }>({
      policy: 'latest',
      maxItems: 20,
      maxBytes: 1,
      sizeOf: () => 1,
    });
    expect(channel.offer({ revision: 1 })).toEqual({ outcome: 'queued' });
    expect(channel.offer({ revision: 2 })).toEqual({ outcome: 'coalesced', replaced: 1 });
    expect(channel.offer({ revision: 3 })).toEqual({ outcome: 'coalesced', replaced: 1 });
    expect(channel.getSnapshot()).toMatchObject({
      queuedItems: 1,
      queuedBytes: 1,
      coalesced: 2,
    });
    expect(await channel.next()).toEqual({ done: false, value: { revision: 3 } });
  });

  test('one parked reader is delivered directly and a second waiter is refused', async () => {
    const channel = createBoundedChannel<number>({
      policy: 'ordered',
      maxItems: 1,
      maxBytes: 1,
      sizeOf: () => 1,
    });
    const first = channel.next();
    await expect(channel.next()).rejects.toBeInstanceOf(BoundedChannelReaderError);
    expect(channel.offer(42)).toEqual({ outcome: 'delivered' });
    await expect(first).resolves.toEqual({ done: false, value: 42 });
    expect(channel.getSnapshot()).toMatchObject({ waitingReader: false, delivered: 1 });
  });

  test('discard close and abort settle readers and free retained values', async () => {
    const abort = new AbortController();
    const channel = createBoundedChannel<string>({
      policy: 'ordered',
      maxItems: 2,
      maxBytes: 10,
      sizeOf: (value) => value.length,
      signal: abort.signal,
    });
    channel.offer('one');
    channel.offer('two');
    abort.abort();
    expect(channel.getSnapshot()).toMatchObject({
      state: 'closed',
      queuedItems: 0,
      queuedBytes: 0,
      discarded: 2,
    });
    await expect(channel.next()).resolves.toEqual({ done: true, value: undefined });
    expect(channel.close({ mode: 'discard' }).state).toBe('closed');
  });

  test('failure rejects a parked reader and every later read, including undefined causes', async () => {
    const channel = createBoundedChannel<number>({
      policy: 'ordered',
      maxItems: 1,
      maxBytes: 1,
      sizeOf: () => 1,
    });
    const waiting = channel.next();
    channel.fail(undefined);
    await expect(waiting).rejects.toBeUndefined();
    await expect(channel.next()).rejects.toBeUndefined();
    expect(channel.getSnapshot().state).toBe('failed');
  });

  test('many distinct keys cannot exceed the declared retained item bound', () => {
    const channel = createBoundedChannel<{ key: string }>({
      policy: 'ordered',
      maxItems: 5,
      maxBytes: 5,
      sizeOf: () => 1,
    });
    for (let index = 0; index < 1_000; index += 1) {
      channel.offer({ key: `key-${index}` });
    }
    expect(channel.getSnapshot()).toMatchObject({
      queuedItems: 5,
      queuedBytes: 5,
      refused: 995,
    });
  });
});

describe('credit window', () => {
  test('credits never overdraw and one lease replenishes exactly once', () => {
    const window = createCreditWindow({ capacityBytes: 10 });
    const six = window.acquire(6);
    expect(six.outcome).toBe('leased');
    expect(window.acquire(5)).toEqual({
      outcome: 'refused',
      reason: 'insufficient-credit',
    });
    expect(window.acquire(11)).toEqual({
      outcome: 'refused',
      reason: 'larger-than-window',
    });
    if (six.outcome === 'leased') {
      six.lease.release();
      six.lease.release();
    }
    expect(window.getSnapshot()).toMatchObject({
      capacityBytes: 10,
      availableBytes: 10,
      leasedBytes: 0,
      acquired: 1,
      refused: 2,
      replenishedBytes: 6,
    });
    window.close();
    expect(window.acquire(1)).toEqual({ outcome: 'refused', reason: 'closed' });
  });
});
