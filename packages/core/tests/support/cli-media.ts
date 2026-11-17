import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type CliConfig, createCli } from '../../src/entrypoints/cli';
import { defineRuntimeTool } from '../../src/tools/runtime-tool';
import type { McpMediaContent } from '../../src/tools/transfer/view-file-contract';

export const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 0, 255]);
export const AUDIO_BYTES = new Uint8Array([79, 103, 103, 83, 0, 128]);
export const IMAGE = {
  type: 'image',
  data: Buffer.from(IMAGE_BYTES).toString('base64'),
  mimeType: 'image/png',
} satisfies McpMediaContent;
export const AUDIO = {
  type: 'audio',
  data: Buffer.from(AUDIO_BYTES).toString('base64'),
  mimeType: 'audio/ogg',
} satisfies McpMediaContent;

/** The block stdout prints in place of a saved media block. */
export function savedLink(dir: string, name: string, mimeType: string, size: number) {
  return {
    type: 'resource_link',
    uri: pathToFileURL(join(dir, name)).href,
    name,
    mimeType,
    size,
  };
}

export async function runMediaCli(
  data: unknown,
  argv: string[],
  config: Partial<CliConfig> = {},
) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'media',
    version: '1',
    runtimeTools: [
      defineRuntimeTool({
        name: 'media',
        description: 'Return synthetic media',
        identity: { serviceName: 'media', action: 'create', method: 'POST' },
        transports: ['CLI'],
        input: z.object({}),
        output: z.unknown(),
        handler: () => data,
      }),
    ],
    stdin: async () => null,
    ...config,
    argv,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
  });
  return { out, err, code };
}
