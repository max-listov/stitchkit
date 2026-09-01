import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineLifecycle } from '../src/primitives';

const lifecycle = defineLifecycle({
  name: 'example',
  states: ['draft', 'ready', 'closed'],
  roles: ['author', 'reviewer'],
  transitions: {
    submit: { from: 'draft', to: 'ready', by: ['author'] },
    close: {
      from: 'ready',
      to: 'closed',
      by: ['reviewer'],
      payload: z.object({ reason: z.string().min(1) }),
    },
  },
});

describe('declared lifecycle', () => {
  test('derives available actions from the same transition declaration it executes', () => {
    const draft = lifecycle.state('draft');
    expect(lifecycle.availableTransitions(draft, 'author')).toEqual(['submit']);
    expect(lifecycle.availableTransitions(draft, 'reviewer')).toEqual([]);

    const accepted = lifecycle.transition({
      state: draft,
      transition: 'submit',
      role: 'author',
      actorId: 'actor-1',
      subject: { type: 'record', id: 'record-1' },
      eventId: 'event-1',
      occurredAt: '2026-09-01T12:00:00Z',
    });
    expect(accepted.outcome).toBe('transitioned');
    if (accepted.outcome !== 'transitioned') throw new Error('expected transition');
    expect(accepted.state.value).toBe('ready');
    expect(accepted.event.payload).toEqual({
      lifecycle: 'example',
      transition: 'submit',
      from: 'draft',
      to: 'ready',
      data: undefined,
    });
  });

  test('distinguishes state, role and payload refusals', () => {
    const draft = lifecycle.state('draft');
    expect(
      lifecycle.transition({
        state: draft,
        transition: 'close',
        role: 'reviewer',
        actorId: 'actor-1',
        subject: { type: 'record', id: 'record-1' },
        eventId: 'event-1',
        occurredAt: '2026-09-01T12:00:00Z',
        payload: { reason: 'done' },
      }).outcome,
    ).toBe('transition_not_allowed');

    const ready = lifecycle.state('ready');
    expect(
      lifecycle.transition({
        state: ready,
        transition: 'close',
        role: 'author',
        actorId: 'actor-1',
        subject: { type: 'record', id: 'record-1' },
        eventId: 'event-1',
        occurredAt: '2026-09-01T12:00:00Z',
        payload: { reason: 'done' },
      }).outcome,
    ).toBe('role_not_allowed');
    expect(
      lifecycle.transition({
        state: ready,
        transition: 'close',
        role: 'reviewer',
        actorId: 'actor-1',
        subject: { type: 'record', id: 'record-1' },
        eventId: 'event-1',
        occurredAt: '2026-09-01T12:00:00Z',
        payload: { reason: '' },
      }).outcome,
    ).toBe('invalid_payload');
  });

  test('wraps an existing string state without changing persisted data', () => {
    const persistedState: 'draft' | 'ready' | 'closed' = 'ready';
    const state = lifecycle.state(persistedState);
    expect(state.value).toBe(persistedState);
    function assigningLifecycleStateDoesNotCompile() {
      // @ts-expect-error A lifecycle state is immutable; transition() produces the next one.
      state.value = 'closed';
    }
    expect(typeof assigningLifecycleStateDoesNotCompile).toBe('function');
  });
});
