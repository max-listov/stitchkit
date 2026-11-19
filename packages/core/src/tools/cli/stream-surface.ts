import type { EndpointStreamDescriptor } from '../../contract/define';
import type { MethodDef, ServiceDef } from '../../server/types';
import type { MountableTool } from '../mount';
import { toToolName } from '../names';
import { buildToolPresentationSchema } from '../schema/presentation';
import { mergeSchemas } from '../schema/schema';

/** One contract stream exposed as a command: how it is called and what it yields. */
export interface CliStreamOperation {
  tool: MountableTool;
  descriptor: EndpointStreamDescriptor;
}

/** Read the shell name of a CLI stream without materialising its schemas. */
export function cliStreamIdentity(serviceName: string, methodName: string, method: MethodDef) {
  if (!method.stream || !method.expose?.includes('CLI')) return undefined;
  return { name: toToolName(serviceName, methodName), descriptor: method.stream };
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
      const identity = cliStreamIdentity(service.name, methodName, method);
      if (identity === undefined) continue;
      const { name, descriptor } = identity;
      streams.set(name, {
        descriptor,
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
