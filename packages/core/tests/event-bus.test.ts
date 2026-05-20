import { describe, expect, test } from 'bun:test';
import { createEventBus } from '../src/server/event-bus';

describe('event bus', () => {
  test('on — delivers every emit', () => {
    const bus = createEventBus<{ ping: { n: number } }>();
    const seen: number[] = [];
    bus.on('ping', (d) => {
      seen.push(d.n);
    });

    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });

    expect(seen).toEqual([1, 2]);
  });

  test('on — returned unsubscribe stops delivery', () => {
    const bus = createEventBus<{ ping: number }>();
    const seen: number[] = [];
    const off = bus.on('ping', (n) => {
      seen.push(n);
    });

    bus.emit('ping', 1);
    off();
    bus.emit('ping', 2);

    expect(seen).toEqual([1]);
  });

  test('once — fires exactly once', () => {
    const bus = createEventBus<{ ping: number }>();
    const seen: number[] = [];
    bus.once('ping', (n) => {
      seen.push(n);
    });

    bus.emit('ping', 1);
    bus.emit('ping', 2);
    bus.emit('ping', 3);

    expect(seen).toEqual([1]);
  });

  test('once — returned unsubscribe stops it before it fires', () => {
    const bus = createEventBus<{ ping: number }>();
    const seen: number[] = [];
    const off = bus.once('ping', (n) => {
      seen.push(n);
    });

    off();
    bus.emit('ping', 1);

    expect(seen).toEqual([]);
  });

  test('off — removes an on()-registered handler', () => {
    const bus = createEventBus<{ ping: number }>();
    const seen: number[] = [];
    const handler = (n: number): void => {
      seen.push(n);
    };

    bus.on('ping', handler);
    bus.off('ping', handler);
    bus.emit('ping', 1);

    expect(seen).toEqual([]);
  });

  test('off — also removes a once()-registered handler', () => {
    const bus = createEventBus<{ ping: number }>();
    const seen: number[] = [];
    const handler = (n: number): void => {
      seen.push(n);
    };

    bus.once('ping', handler);
    bus.off('ping', handler);
    bus.emit('ping', 1);

    expect(seen).toEqual([]);
  });

  test('emit — a throwing listener does not break the others', () => {
    const bus = createEventBus<{ ping: number }>();
    const seen: number[] = [];
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', (n) => {
      seen.push(n);
    });

    bus.emit('ping', 7);

    expect(seen).toEqual([7]);
  });

  test('emit — no listeners is a no-op', () => {
    const bus = createEventBus<{ ping: number }>();
    expect(() => bus.emit('ping', 1)).not.toThrow();
  });

  test('clear — drops every subscription', () => {
    const bus = createEventBus<{ ping: number }>();
    const seen: number[] = [];
    bus.on('ping', (n) => {
      seen.push(n);
    });

    bus.clear();
    bus.emit('ping', 1);

    expect(seen).toEqual([]);
  });
});
