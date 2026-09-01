import { type ZodType, z } from 'zod';
import { ManagedFileRefSchema } from '../contract';

export function createExportResultSchema<TOperationId extends ZodType>(
  operationId: TOperationId,
) {
  return z.discriminatedUnion('state', [
    z.object({
      state: z.literal('ready'),
      file: ManagedFileRefSchema.extend({
        mediaType: z.string().min(1),
        name: z.string().min(1),
      }),
    }),
    z.object({ state: z.literal('pending'), operationId }),
  ]);
}

export function defineExportOperation<
  TInput extends ZodType,
  TOperationId extends ZodType,
>(config: {
  readonly input: TInput;
  readonly operationId: TOperationId;
  readonly mediaType: string;
  readonly filename: (input: z.output<TInput>) => string;
}) {
  if (config.mediaType.trim() === '')
    throw new Error('[stitchkit] export mediaType is required');
  const result = createExportResultSchema(config.operationId);
  return Object.freeze({
    input: config.input,
    result,
    ready(
      inputValue: z.input<TInput>,
      file: { readonly path: string; readonly size: number },
    ): z.output<typeof result> {
      const input = config.input.parse(inputValue);
      return result.parse({
        state: 'ready',
        file: {
          ...file,
          mediaType: config.mediaType,
          name: config.filename(input),
        },
      });
    },
    pending(operationId: z.input<TOperationId>): z.output<typeof result> {
      return result.parse({ state: 'pending', operationId });
    },
    endpoint<const TScope extends string>(definition: {
      readonly method: 'GET' | 'POST';
      readonly path: string;
      readonly desc: string;
      readonly scope: TScope;
      readonly toolName?: string;
      readonly meta?: Record<string, unknown>;
    }) {
      return {
        ...definition,
        input: config.input,
        output: result,
      };
    },
  });
}
