import { z } from 'zod';
import { isJsonData } from '../internal/json-data';

export const DurableJsonSchema = z.custom<z.infer<ReturnType<typeof z.json>>>(
  (value) =>
    isJsonData(value, {
      maxDepth: 100,
      maxNodes: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
      omitObjectUndefined: false,
    }),
  'Expected lossless JSON data (finite numbers, plain objects and dense arrays; no accessors)',
);
