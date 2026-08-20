/**
 * `mountDownload` — a generic native MCP tool that saves a result URL to the
 * local filesystem. The app injects how to resolve the URL from the call's
 * args; the fetch / extension / write mechanics live here. → ADR 0019.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isRecord } from '../internal/typed';
import { runDownloadOperation } from './download-core';
import { assertToolName } from './names';
import { textResult } from './native-result';

export interface DownloadToolConfig {
  /** Tool name. Default `'download'`. */
  name?: string;
  description: string;
  /** Tool input shape (e.g. `{ url: z.string().optional(), id: z.string().optional() }`). */
  inputSchema: z.ZodRawShape;
  /** Resolve the args to a media URL — `null` when there is nothing to download. */
  resolveUrl: (args: Record<string, unknown>) => Promise<string | null> | string | null;
  /** Directory to save into by default. */
  defaultDir: string;
  /** Read a per-call output directory from the args. */
  dirFromArgs?: (args: Record<string, unknown>) => string | undefined;
  /**
   * Allow downloading from private / internal / loopback hosts. Default `false`
   * — the SSRF guard, since the URL comes from model-controlled args. Enable
   * only in a trusted network.
   */
  allowPrivateHosts?: boolean;
  /** Max bytes to read before aborting (memory cap). Default 100 MB. */
  maxBytes?: number;
  /**
   * Deadline for producing response headers (DNS, connects and redirects share
   * it). Default 15 seconds.
   */
  timeoutMs?: number;
}

/**
 * Register a native "download" tool — resolves a URL from the args, fetches it
 * and writes it to disk with a content-type / URL-derived extension. Returns
 * the saved path / size / mime.
 */
export function mountDownload(server: McpServer, config: DownloadToolConfig): void {
  const name = config.name ?? 'download';
  // A native tool lands in the SAME `tools/list` as the contract tools, so one
  // undeliverable name here takes them all down too. → ADR 0035.
  assertToolName(name, '<native>', 'download');
  server.registerTool(
    name,
    { description: config.description, inputSchema: z.object(config.inputSchema) },
    async (rawArgs) => {
      const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
      // One boundary for every failure mode — resolveUrl, fetch rejection,
      // mkdir/writeFile (EACCES/ENOSPC), body stream — all report with the
      // same `Download failed:` prefix rather than a bare rejection.
      try {
        const url = await config.resolveUrl(args);
        if (!url) return textResult('Nothing to download.', true);

        const result = await runDownloadOperation({
          url,
          dir: config.dirFromArgs?.(args) ?? config.defaultDir,
          allowPrivateHosts: config.allowPrivateHosts,
          maxBytes: config.maxBytes,
          timeoutMs: config.timeoutMs,
        });
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return textResult(
          `Download failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );
}
