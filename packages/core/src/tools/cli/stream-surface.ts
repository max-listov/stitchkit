import type { EndpointStreamDescriptor } from '../../contract/define';
import type { ServiceDef } from '../../server/types';
import type { MountableTool } from '../mount';
import { toToolName } from '../names';
import { buildToolPresentationSchema } from '../schema/presentation';
import { mergeSchemas } from '../schema/schema';

/** One contract stream exposed as a command: how it is called and what it yields. */
export interface CliStreamOperation {
  tool: MountableTool;
  descriptor: EndpointStreamDescriptor;
}

/**
 * The contract streams a CLI carries, by command name.
 *
 * A stream is not a tool — a model call has one answer — so the tool surface
 * never projects it. A terminal can carry a feed, a line per item, and this is
 * the walk that finds the streams whose contract says so (`expose` lists `'CLI'`).
 */
export function collectCliStreams(
  services: readonly ServiceDef[],
): Map<string, CliStreamOperation> {
  const streams = new Map<string, CliStreamOperation>();
  for (const service of services) {
    for (const [methodName, method] of Object.entries(service.methods)) {
      if (method.stream === undefined || !method.expose?.includes('CLI')) continue;
      const name = toToolName(service.name, methodName);
      streams.set(name, {
        descriptor: method.stream,
        tool: {
          method,
          name,
          argumentSchema: mergeSchemas(method.paramsSchema, method.inputSchema),
          presentationSchema: buildToolPresentationSchema({
            paramsSchema: method.paramsSchema,
            inputSchema: method.inputSchema,
            unrepresentable: 'any',
          }),
          shouldExtend: false,
        },
      });
    }
  }
  return streams;
}
