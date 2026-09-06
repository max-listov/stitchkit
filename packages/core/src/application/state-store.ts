/** A value and the result produced by one atomic state transition. */
export interface StateStoreUpdate<TState, TResult> {
  readonly state: TState;
  readonly result: TResult;
}

/**
 * Persistence boundary for small application state machines.
 *
 * `update` owns the read/modify/write critical section. Keeping that operation
 * on the store, rather than building it from public `read` and `write` calls,
 * is what lets file and database adapters protect two application processes
 * from silently overwriting one another.
 */
export interface StateStore<TState> {
  read(): Promise<TState | null>;
  update<TResult>(
    transition: (
      current: TState | null,
    ) => StateStoreUpdate<TState, TResult> | Promise<StateStoreUpdate<TState, TResult>>,
  ): Promise<TResult>;
}
