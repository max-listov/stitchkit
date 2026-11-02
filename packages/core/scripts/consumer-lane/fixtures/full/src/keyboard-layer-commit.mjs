import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  act,
  createElement,
  StrictMode,
  Suspense,
  startTransition,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

// DOM globals precede both react-dom and the browser binding, as in a browser entrypoint.
GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
// The source regression supplies its entrypoint; installed proofs use only the public package.
const { useKeyLayer, useEscapeLayer, useNavZone } = await import(
  process.argv[2] ?? 'stitchkit/react/keyboard'
);

function press(target) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const heard = [];
const commits = [];
const settled = [];
const never = new Promise(() => {
  // The transition must stay uncommitted until the next synchronous render replaces it.
});

function Layer({
  active = true,
  inert = false,
  version = 'current',
  binding = 'key',
  phase,
  suspend = false,
}) {
  const scope = useRef(null);
  const onKey = () => {
    heard.push(version);
    return true;
  };
  useKeyLayer({ kind: 'local', active: binding === 'key' && active, scope, phase, onKey });
  useEscapeLayer({
    kind: 'route',
    active: binding === 'escape' && active,
    scope,
    onEscape: onKey,
  });
  const sample = (into) => {
    const before = heard.length;
    const handled = press(scope.current);
    into.push({ active, inert, version, handled, calls: heard.slice(before) });
  };
  useLayoutEffect(() => sample(commits));
  useEffect(() => sample(settled));
  if (suspend) use(never);
  return createElement('section', { ref: scope, inert }, version);
}

function last(into, active, inert, version) {
  assert.deepEqual(into.at(-1), {
    active,
    inert,
    version,
    handled: active && !inert,
    calls: active && !inert ? [version] : [],
  });
}

function UnscopedLayer() {
  useKeyLayer({
    kind: 'route',
    onKey: () => {
      heard.push('removed');
      return true;
    },
  });
  return null;
}

function Removal({ visible }) {
  useLayoutEffect(() => {
    if (!visible) {
      const before = heard.length;
      assert.equal(press(window), false);
      assert.equal(heard.length, before);
    }
  });
  return visible ? createElement(UnscopedLayer) : null;
}

const zoneCommits = [];
function Zone({ active }) {
  const zone = useNavZone({ items: ['one'], role: 'none', mode: 'focus', active });
  useLayoutEffect(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    zoneCommits.push({ active, handled: event.defaultPrevented });
  }, [active]);
  return createElement(
    'div',
    zone.zoneProps,
    createElement('button', { type: 'button', ...zone.itemProps('one') }, 'One'),
  );
}

// A boundary hides committed content: its layer goes quiet and returns to its own place.
const taken = [];
function Hidden({ pending }) {
  useKeyLayer({
    kind: 'route',
    onKey: () => {
      taken.push('hidden');
      return true;
    },
  });
  if (pending) use(pending);
  return createElement('span', null, 'content');
}
function ActivatedLater({ active }) {
  useKeyLayer({
    kind: 'route',
    active,
    onKey: () => {
      taken.push('later');
      return true;
    },
  });
  return null;
}
async function hiddenLayerKeepsItsPlace(container) {
  const root = createRoot(container);
  const show = (pending, active) =>
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Suspense, { fallback: 'pending' }, createElement(Hidden, { pending })),
          createElement(ActivatedLater, { active }),
        ),
      ),
    );
  const { promise, resolve } = Promise.withResolvers();
  await show(undefined, false);
  await show(undefined, true);
  await show(promise, true);
  press(window);
  await act(async () => resolve());
  await show(undefined, true);
  press(window);
  await act(() => root.unmount());
  assert.deepEqual(taken, ['later', 'later']);
}

const container = document.createElement('div');
document.body.append(container);
let root;
try {
  await hiddenLayerKeepsItsPlace(container);
  for (const binding of ['key', 'escape']) {
    for (const phase of binding === 'key' ? ['bubble', 'capture'] : [undefined]) {
      root = createRoot(container);
      const show = async (options) => {
        await act(() =>
          root.render(
            createElement(
              StrictMode,
              null,
              createElement(
                Suspense,
                { fallback: 'pending' },
                createElement(Layer, { binding, phase, ...options }),
              ),
            ),
          ),
        );
      };
      await show({ active: true, version: 'initial' });
      last(commits, true, false, 'initial');
      last(settled, true, false, 'initial');
      await show({ active: false, version: 'inactive' });
      last(commits, false, false, 'inactive');
      last(settled, false, false, 'inactive');
      await show({ active: true, version: 'reactivated' });
      last(commits, true, false, 'reactivated');
      last(settled, true, false, 'reactivated');
      await show({ active: true, version: 'updated' });
      last(commits, true, false, 'updated');
      await show({ active: true, inert: true, version: 'inert' });
      last(commits, true, true, 'inert');
      last(settled, true, true, 'inert');
      await show({ active: true, version: 'committed' });
      await act(() =>
        startTransition(() =>
          root.render(
            createElement(
              StrictMode,
              null,
              createElement(
                Suspense,
                { fallback: 'pending' },
                createElement(Layer, {
                  binding,
                  phase,
                  active: false,
                  version: 'abandoned',
                  suspend: true,
                }),
              ),
            ),
          ),
        ),
      );
      const before = heard.length;
      assert.equal(press(container.firstElementChild), true);
      assert.deepEqual(heard.slice(before), ['committed']);
      await show({ active: false, version: 'final-inactive' });
      last(commits, false, false, 'final-inactive');
      last(settled, false, false, 'final-inactive');
      const inactiveCount = heard.length;
      assert.equal(press(container.firstElementChild), false);
      assert.equal(heard.length, inactiveCount);
      // Remove an active layer: cleanup must detach the last listener before another key.
      await show({ active: true, version: 'before-unmount' });
      await act(() => root.unmount());
      root = undefined;
      const unmountedCount = heard.length;
      assert.equal(press(window), false);
      assert.equal(heard.length, unmountedCount);
    }
  }
  root = createRoot(container);
  await act(() => root.render(createElement(Removal, { visible: true })));
  await act(() => root.render(createElement(Removal, { visible: false })));
  await act(() => root.unmount());
  root = createRoot(container);
  for (const active of [false, true, false]) {
    await act(() => root.render(createElement(Zone, { active })));
    assert.deepEqual(zoneCommits.at(-1), { active, handled: active });
    if (active) assert.equal(document.activeElement, container.querySelector('button'));
  }
  await act(() => root.unmount());
  root = undefined;
  console.log('packed keyboard layer commit: ok');
} finally {
  if (root) await act(() => root.unmount());
  container.remove();
  await GlobalRegistrator.unregister();
}
