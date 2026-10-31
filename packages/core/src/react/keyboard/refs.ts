import type { Ref } from 'react';

/**
 * One ref callback for several refs: a zone's `ref` beside a drag handle's, a
 * measuring hook's or the application's own. Spread the zone's props, then set
 * `ref: mergeRefs(props.ref, other)` — a later `ref` replaces an earlier one,
 * and a merged ref keeps both.
 *
 * The result is a new function on every call. React detaches and re-attaches a
 * callback ref whose identity changes, so a component that renders often keeps
 * it in `useMemo`/`useCallback`.
 */
export function mergeRefs<T>(
  ...refs: readonly (Ref<T> | undefined)[]
): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref !== null && ref !== undefined) ref.current = node;
    }
  };
}
