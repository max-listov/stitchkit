/**
 * `mountUpload` — a generic native MCP tool that uploads a local file. The app
 * injects how to read + send the file (`upload`); the tool wiring lives here.
 * → ADR 0019.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isRecord } from '../internal/typed';
import { assertToolName } from './names';
import { textResult } from './native-result';
import { runUploadOperation } from './upload-core';

export interface UploadToolConfig {
  /** Tool name. Default `'upload'`. */
  name?: string;
  description: string;
  /** Read a local `path` and upload it, returning whatever the upload yields. */
  upload: (path: string) => Promise<unknown>;
}

/**
 * Register a native "upload" tool — takes a local `path`, hands it to
 * `config.upload` (which reads + sends it) and returns the result.
 */
export function mountUpload(server: McpServer, config: UploadToolConfig): void {
  const name = config.name ?? 'upload';
  // A native tool lands in the SAME `tools/list` as the contract tools, so one
  // undeliverable name here takes them all down too. → ADR 0035.
  assertToolName(name, '<native>', 'upload');
  server.registerTool(
    name,
    {
      description: config.description,
      inputSchema: { path: z.string().describe('Path to a local file on this machine') },
    },
    async (rawArgs) => {
      const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return textResult('Provide `path`.', true);
      try {
        // `config.upload` may resolve to `undefined`; `JSON.stringify(undefined)`
        // is the JS value `undefined`, not a string — coerce to `null` so the
        // text block is always a valid string.
        const uploaded = await runUploadOperation(path, config.upload);
        return textResult(JSON.stringify(uploaded ?? null, null, 2));
      } catch (err) {
        return textResult(
          `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );
}
