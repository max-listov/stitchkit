import type { z } from 'zod';
import { isRecord } from '../internal/typed';
import { type GeoAttribution, GeoAttributionSchema, GeoTextSchema } from './schema';

const FIELDS = GeoAttributionSchema.unwrap().shape;
type LocalizedNames = NonNullable<GeoAttribution['localizedNames']>;

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** One field as its schema accepts it; anything else is absent, not a failed snapshot. */
function field<Value>(schema: z.ZodType<Value>, value: unknown): Value | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The names of one place: every locale whose code and label are text. */
function names(entry: Record<string, unknown> | undefined) {
  const source = record(entry?.names);
  if (!source) return undefined;
  const entries = Object.entries(source).filter(
    (pair): pair is [string, string] =>
      GeoTextSchema.safeParse(pair[0]).success && GeoTextSchema.safeParse(pair[1]).success,
  );
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

/** The same object without the keys whose value is `undefined`, frozen. */
function sparse<Value extends object>(value: Value): Value {
  for (const key of Object.keys(value)) {
    if (Reflect.get(value, key) === undefined) Reflect.deleteProperty(value, key);
  }
  return Object.freeze(value);
}

/**
 * Map a City + ASN record to the complete sparse snapshot without exposing
 * optional-peer types. Each field is validated by the schema on its own, so a
 * malformed value drops that field and keeps the rest.
 */
export function mapGeoIpRecord(value: unknown): GeoAttribution | null {
  const root = record(value);
  if (!root) return null;
  const continent = record(root.continent);
  const country = record(root.country);
  const registeredCountry = record(root.registered_country);
  const region = Array.isArray(root.subdivisions) ? record(root.subdivisions[0]) : undefined;
  const city = record(root.city);
  const postal = record(root.postal);
  const location = record(root.location);
  const localizedNames: LocalizedNames = sparse({
    continent: names(continent),
    country: names(country),
    registeredCountry: names(registeredCountry),
    region: names(region),
    city: names(city),
  });
  const result: GeoAttribution = sparse({
    continentCode: field(FIELDS.continentCode, continent?.code),
    continentName: field(FIELDS.continentName, localizedNames.continent?.en),
    continentGeonameId: field(FIELDS.continentGeonameId, continent?.geoname_id),
    countryCode: field(FIELDS.countryCode, country?.iso_code),
    countryName: field(FIELDS.countryName, localizedNames.country?.en),
    countryGeonameId: field(FIELDS.countryGeonameId, country?.geoname_id),
    registeredCountryCode: field(FIELDS.registeredCountryCode, registeredCountry?.iso_code),
    registeredCountryName: field(
      FIELDS.registeredCountryName,
      localizedNames.registeredCountry?.en,
    ),
    registeredCountryGeonameId: field(
      FIELDS.registeredCountryGeonameId,
      registeredCountry?.geoname_id,
    ),
    regionCode: field(FIELDS.regionCode, region?.iso_code),
    regionName: field(FIELDS.regionName, localizedNames.region?.en),
    regionGeonameId: field(FIELDS.regionGeonameId, region?.geoname_id),
    city: field(FIELDS.city, localizedNames.city?.en),
    cityGeonameId: field(FIELDS.cityGeonameId, city?.geoname_id),
    postalCode: field(FIELDS.postalCode, postal?.code),
    latitude: field(FIELDS.latitude, location?.latitude),
    longitude: field(FIELDS.longitude, location?.longitude),
    timezone: field(FIELDS.timezone, location?.time_zone),
    accuracyRadiusKm: field(FIELDS.accuracyRadiusKm, location?.accuracy_radius),
    autonomousSystemNumber: field(
      FIELDS.autonomousSystemNumber,
      root.autonomous_system_number,
    ),
    autonomousSystemOrganization: field(
      FIELDS.autonomousSystemOrganization,
      root.autonomous_system_organization,
    ),
    localizedNames: Object.keys(localizedNames).length > 0 ? localizedNames : undefined,
  });
  return Object.keys(result).length > 0 ? result : null;
}
