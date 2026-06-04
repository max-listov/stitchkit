/**
 * The MCP text-content result shape shared by the native tools (`mountWait`,
 * `mountDownload`, `mountUpload`) — one place so each tool file does not
 * re-spell the `{ content: [{ type: 'text' }], isError }` envelope.
 */

export interface NativeTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** MCP tool results carry an open `_meta` etc. — the SDK's result type is index-signed. */
  [key: string]: unknown;
}

/** A single text block, optionally flagged as an error. */
export function textResult(text: string, isError = false): NativeTextResult {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text }];
  return isError ? { content, isError: true } : { content };
}
