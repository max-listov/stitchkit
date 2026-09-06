/**
 * The media type without its parameters, lower-cased — what the Fetch spec
 * calls the essence. Compared whole, never as a substring: `text/plain;
 * charset=application/json` is a `text/plain` body, and `application/JSON`
 * is JSON.
 */
export function mediaTypeEssence(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
