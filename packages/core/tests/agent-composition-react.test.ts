import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, StrictMode } from 'react';
import type { createRoot as CreateRoot } from 'react-dom/client';
import {
  type AgentController,
  type AgentControllerState,
  createAgentControlView,
} from '../src/entrypoints/agent-runtime/browser';
import { useAgent } from '../src/entrypoints/agent-runtime/react';

let createRoot: typeof CreateRoot;
beforeAll(async () => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  ({ createRoot } = await import('react-dom/client'));
});
afterAll(() => GlobalRegistrator.unregister());

test('React views share one controller through StrictMode and unmount only their own subscriptions', () => {
  let state: AgentControllerState = { status: 'connecting', view: createAgentControlView() };
  const listeners = new Set<() => void>();
  let closed = 0;
  const controller: AgentController = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request: async () => ({ schemaVersion: 1, requestId: 'unused', outcome: 'ok' }),
    close: async () => {
      closed += 1;
    },
  };
  function View() {
    return createElement('p', null, useAgent(controller).status);
  }
  const first = document.createElement('div');
  const second = document.createElement('div');
  const a = createRoot(first);
  const b = createRoot(second);
  try {
    act(() => {
      a.render(createElement(StrictMode, null, createElement(View)));
      b.render(createElement(View));
    });
    expect(listeners.size).toBe(2);
    act(() => {
      state = { ...state, status: 'ready' };
      for (const listener of listeners) listener();
    });
    expect(first.textContent).toBe('ready');
    expect(second.textContent).toBe('ready');
    act(() => a.unmount());
    expect(listeners.size).toBe(1);
    expect(closed).toBe(0);
    act(() => {
      state = { ...state, status: 'disconnected' };
      for (const listener of listeners) listener();
    });
    expect(second.textContent).toBe('disconnected');
  } finally {
    act(() => b.unmount());
  }
  expect(listeners.size).toBe(0);
  expect(closed).toBe(0);
});
