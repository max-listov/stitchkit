/** Fetch-compatible delivery seam shared by the typed and configured clients. */
export type ClientFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
