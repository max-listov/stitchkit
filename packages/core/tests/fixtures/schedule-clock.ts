/** Deterministic timers with real timer handles, never wall-clock waits. */
export function scheduleClock() {
  let time = Date.parse('2026-09-26T00:00:00.000Z');
  const timers = new Map<
    ReturnType<typeof setTimeout>,
    { at: number; callback: () => void }
  >();
  const delays: number[] = [];
  return {
    now: () => new Date(time),
    advance(ms: number) {
      time += ms;
    },
    setTimer(callback: () => void, delay: number) {
      const handle = setTimeout(() => undefined, 2_147_483_647);
      clearTimeout(handle);
      timers.set(handle, { at: time + delay, callback });
      delays.push(delay);
      return handle;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle);
    },
    fire() {
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    delays,
    timers,
  };
}
