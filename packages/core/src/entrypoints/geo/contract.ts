/**
 * `stitchkit/geo/contract` — the shape of a place snapshot, for code on both
 * sides of the wire: a shared schema validates a stored or transported
 * `GeoAttribution` without the server-only resolver. Brings `zod`.
 */
export { type GeoAttribution, GeoAttributionSchema } from '../../geo/schema';
