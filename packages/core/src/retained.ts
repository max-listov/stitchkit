/**
 * Retained-last-value memory for pub/sub topics — "sticky events".
 *
 * A subscriber that connects (or a component that mounts / re-renders) *after* an
 * event was published would otherwise miss it and show stale state until the next
 * publish. Record each topic's last payload and replay it to a fresh subscriber,
 * so a late one catches up at once — the pub/sub analogue of MQTT's "retained"
 * message or an RxJS `BehaviorSubject`.
 *
 * Transport-agnostic: wrap it around any pub/sub. `createSocketIOClient`'s
 * `retain` option uses it internally, and a bring-your-own-transport lane (a raw
 * WebSocket driving a contract through the app's own dispatch loop) can use it
 * directly for its own event channel. Browser-safe — no Node built-ins.
 */
export interface RetainedTopics<Events extends Record<string, unknown>> {
  /** Record a topic's latest payload — call on every publish / receive. */
  record<K extends keyof Events & string>(topic: K, payload: Events[K]): void;
  /** Replay the retained payload, if any, to a just-subscribed handler. */
  replay<K extends keyof Events & string>(
    topic: K,
    handler: (payload: Events[K]) => void,
  ): void;
  /** The retained payload for a topic, or `undefined` if none recorded yet. */
  get<K extends keyof Events & string>(topic: K): Events[K] | undefined;
  /** Forget a topic's retained value, or every topic when `topic` is omitted. */
  clear(topic?: keyof Events & string): void;
}

/**
 * Create a {@link RetainedTopics} store. `Events` maps each topic name to its
 * payload type, so `record` / `replay` / `get` are typed per topic.
 */
export function createRetainedTopics<
  Events extends Record<string, unknown>,
>(): RetainedTopics<Events> {
  const last: Partial<Events> = {};
  return {
    record(topic, payload) {
      last[topic] = payload;
    },
    replay(topic, handler) {
      const value = last[topic];
      if (value !== undefined) handler(value);
    },
    get(topic) {
      return last[topic];
    },
    clear(topic) {
      if (topic !== undefined) {
        delete last[topic];
        return;
      }
      for (const key of Object.keys(last)) Reflect.deleteProperty(last, key);
    },
  };
}
