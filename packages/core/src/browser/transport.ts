/** Fetch-compatible delivery seam shared by the typed and configured clients. */
export type ClientFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
