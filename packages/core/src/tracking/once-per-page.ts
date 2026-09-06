/**
 * One fact per key per page within a window.
 *
 * A component that records "opened X" can mount twice on the same page —
 * StrictMode, an RSC tree refresh, a layout re-render — and each mount has its
 * own fresh refs, so a guard inside the component cannot see the first one.
 * The memory lives at document scope instead: the same key on the same page
 * within the window is the same fact. A different page is a new one.
 */
export interface OncePerPage {
  should(key: string, page: string): boolean;
}

export function createOncePerPage(
  options: { windowMs?: number; now?: () => number } = {},
): OncePerPage {
  const windowMs = options.windowMs ?? 15_000;
  const now = options.now ?? (() => Date.now());
  const seen = new Map<string, number>();
  return {
    should(key, page) {
      const scoped = `${page}|${key}`;
      const at = now();
      const last = seen.get(scoped);
      if (last !== undefined && at - last < windowMs) return false;
      seen.set(scoped, at);
      return true;
    },
  };
}
