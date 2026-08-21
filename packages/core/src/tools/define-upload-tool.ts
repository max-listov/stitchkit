import { type ZodType, z } from 'zod';
import { ManagedFilePathSchema } from '../contract/file-ref';
import type { ManagedFileBoundary, ManagedFileSource } from '../files/boundary';
import { managedFileAppError } from './managed-file-error';
import { type ManagedNativeToolConfig, managedNativeIdentity } from './native-definition';
import {
  defineRuntimeTool,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolHandlerContext,
  type RuntimeToolPresenters,
} from './runtime-tool';
import { runUploadOperation } from './upload-core';

export const UploadToolInputSchema = z.object({
  path: ManagedFilePathSchema.describe('Path relative to the configured file boundary'),
});

export interface DefineUploadToolConfig<TOutput extends ZodType>
  extends ManagedNativeToolConfig {
  output: TOutput;
  files: ManagedFileBoundary;
  upload: (
    source: ManagedFileSource,
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
    handler: async (context) => {
      try {
        return await runUploadOperation(
          config.files,
          context.input.path,
          (source) => config.upload(source, context),
          context.signal,
        );
      } catch (error) {
        const managedError = managedFileAppError(error);
        if (managedError) throw managedError;
        throw error;
      }
    },
  });
}
