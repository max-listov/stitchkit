import { z } from 'zod';
import type { EndpointDef, EndpointStreamDescriptor } from './define';
import { ALL_TRANSPORTS } from './transports';

type EndpointCapabilities = Pick<
  EndpointDef,
  'method' | 'rawResponse' | 'rawBody' | 'responseMeta' | 'multipart'
> & { stream?: EndpointStreamDescriptor };

const HTTP_ONLY_FEATURES = [
  'rawResponse',
  'rawBody',
  'responseMeta',
  'multipart',
  'stream',
] satisfies readonly (keyof EndpointCapabilities)[];

export type HttpOnlyFeature = (typeof HTTP_ONLY_FEATURES)[number];

export type HttpOnlyEndpointShape =
  | { method: 'HEAD' }
  | {
      [Feature in (typeof HTTP_ONLY_FEATURES)[number]]: Required<
        Pick<EndpointCapabilities, Feature>
      >;
    }[(typeof HTTP_ONLY_FEATURES)[number]];

export const HTTP_ONLY_EXPOSURE = Object.freeze<['HTTP']>(['HTTP']);
export const ExposureSchema = z
  .array(z.enum(ALL_TRANSPORTS))
  .refine((transports) => new Set(transports).size === transports.length, {
    message: 'Each transport appears at most once',
  })
  .readonly();

/**
 * Whether a transport other than HTTP can carry the endpoint. A contract HEAD
 * endpoint also declares `rawResponse`; the method is checked as well because
 * a `MethodDef` assembled at runtime never met that type.
 */
export function isHttpOnlyEndpoint(endpoint: EndpointCapabilities): boolean {
  return (
    endpoint.method === 'HEAD' ||
    HTTP_ONLY_FEATURES.some((feature) => Boolean(endpoint[feature]))
  );
}

export function assertEndpointExposure(
  prefix: string,
  key: string,
  endpoint: EndpointDef,
): void {
  if (endpoint.expose === undefined) return;
  const exposure = ExposureSchema.safeParse(endpoint.expose);
  const where = `Contract "${prefix}": endpoint "${key}"`;
  if (!exposure.success) {
    throw new Error(
      `${where} expose must be an array of distinct transports: ${ALL_TRANSPORTS.join(' / ')}`,
    );
  }
  if (isHttpOnlyEndpoint(endpoint)) {
    // A stream is the one HTTP-only shape a terminal can also carry: a line per
    // item. It is still never a tool — a model call has one answer, not a feed.
    const carriers: readonly string[] =
      'stream' in endpoint && endpoint.stream ? ['HTTP', 'CLI'] : ['HTTP'];
    const unsupported = exposure.data.filter((transport) => !carriers.includes(transport));
    if (unsupported.length > 0) {
      throw new Error(
        carriers.length > 1
          ? `${where} is a stream, carried by ${carriers.join(' and ')} only — remove ${unsupported.join(', ')} from expose`
          : `${where} is HTTP-only — remove ${unsupported.join(', ')} from expose`,
      );
    }
  }
}
