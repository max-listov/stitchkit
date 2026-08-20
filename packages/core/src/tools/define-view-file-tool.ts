import type { z } from 'zod';
import { type ManagedNativeToolConfig, managedNativeIdentity } from './native-definition';
import {
  defineRuntimeTool,
  type RuntimeAgentModelOutput,
  type RuntimeMcpPresentation,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolPresenters,
} from './runtime-tool';
import {
  runViewFileOperation,
  ViewFileInputSchema,
  type ViewFileOptions,
  ViewFileOutputSchema,
} from './view-file';

export interface DefineViewFileToolConfig extends ManagedNativeToolConfig, ViewFileOptions {
  present?: RuntimeToolPresenters<z.output<typeof ViewFileOutputSchema>>;
}

/** Define one protected managed multimodal media-inspection operation. */
export function defineViewFileTool(
  config: DefineViewFileToolConfig,
): RuntimeToolDefinitionWithOutput<typeof ViewFileInputSchema, typeof ViewFileOutputSchema> {
  const defaults: RuntimeToolPresenters<z.output<typeof ViewFileOutputSchema>> = {
    mcp: (output): RuntimeMcpPresentation => ({ content: output.content }),
    agent: (output): RuntimeAgentModelOutput => ({
      type: 'content',
      value: output.content.map((part) => {
        if (part.type === 'text') return part;
        return {
          type: 'file',
          data: { type: 'data', data: part.data },
          mediaType: part.mimeType,
        };
      }),
    }),
  };

  return defineRuntimeTool({
    name: config.name ?? 'view_file',
    description: config.description,
    identity: managedNativeIdentity(config.identity, 'GET'),
    input: ViewFileInputSchema,
    output: ViewFileOutputSchema,
    transports: config.transports,
    annotations: config.annotations ?? {
      title: 'View Media',
      readOnlyHint: true,
      idempotentHint: true,
    },
    present: { ...defaults, ...config.present },
    handler: (context) =>
      runViewFileOperation(
        context.input.paths,
        {
          baseDir: config.baseDir,
          allowPrivateHosts: config.allowPrivateHosts,
          timeoutMs: config.timeoutMs,
        },
        context.signal,
      ),
  });
}
