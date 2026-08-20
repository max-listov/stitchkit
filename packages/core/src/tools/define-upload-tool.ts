import { type ZodType, z } from 'zod';
import { type ManagedNativeToolConfig, managedNativeIdentity } from './native-definition';
import {
  defineRuntimeTool,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolHandlerContext,
  type RuntimeToolPresenters,
} from './runtime-tool';
import { runUploadOperation } from './upload-core';

export const UploadToolInputSchema = z.object({
  path: z.string().min(1).describe('Path to a local file on this machine'),
});

export interface DefineUploadToolConfig<TOutput extends ZodType>
  extends ManagedNativeToolConfig {
  output: TOutput;
  upload: (
    path: string,
    context: RuntimeToolHandlerContext<typeof UploadToolInputSchema>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
  present?: RuntimeToolPresenters<z.output<TOutput>>;
}

/** Define one managed local-file upload operation. */
export function defineUploadTool<TOutput extends ZodType>(
  config: DefineUploadToolConfig<TOutput>,
): RuntimeToolDefinitionWithOutput<typeof UploadToolInputSchema, TOutput> {
  return defineRuntimeTool({
    name: config.name ?? 'upload',
    description: config.description,
    identity: managedNativeIdentity(config.identity, 'POST'),
    input: UploadToolInputSchema,
    output: config.output,
    transports: config.transports,
    annotations: config.annotations,
    present: config.present,
    handler: async (context) =>
      runUploadOperation(
        context.input.path,
        (path) => config.upload(path, context),
        context.signal,
      ),
  });
}
