/** The part of a `node:http` server `listenFetchable` drives. */
export interface ListeningServer {
  listen(port: number, host: string, done: () => void): unknown;
  address(): { port: number } | string | null;
  close(done: (error?: Error) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

/** The last port on the Fetch block list. */
export declare const HIGHEST_FETCH_BLOCKED_PORT: number;

/** Bind `server` to a loopback port above the Fetch block list and return the port. */
export declare function listenFetchable(
  server: ListeningServer,
  host?: string,
): Promise<number>;
