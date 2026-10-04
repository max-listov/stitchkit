import type { EndpointDef } from '../contract/define';

/** The argument shape shared by typed method construction and remote forwarding. */
export function endpointHasArguments(endpoint: EndpointDef): boolean {
  return Boolean(endpoint.params || endpoint.input || endpoint.multipart);
}
