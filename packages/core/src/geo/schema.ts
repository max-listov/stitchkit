import { z } from 'zod';

/** A label as the GeoIP database spells it; an empty string is no label. */
export const GeoTextSchema = z.string().min(1);
/** GeoNames IDs and the accuracy radius: whole, nonnegative and exact. */
export const GeoNonnegativeIntegerSchema = z.number().int().nonnegative();
/** One place's names by locale code, every language the database carries. */
export const GeoLocalizedNamesSchema = z.record(GeoTextSchema, GeoTextSchema).readonly();

const GeoLocalizedNameSetSchema = z
  .strictObject({
    continent: GeoLocalizedNamesSchema.optional(),
    country: GeoLocalizedNamesSchema.optional(),
    registeredCountry: GeoLocalizedNamesSchema.optional(),
    region: GeoLocalizedNamesSchema.optional(),
    city: GeoLocalizedNamesSchema.optional(),
  })
  .readonly();

/**
 * Where an IP address is, as a GeoLite2 / GeoIP2 City and ASN record says it.
 * Every field is optional: a record states what it knows. The located country
 * and the country the address block is registered to are separate facts.
 */
export const GeoAttributionSchema = z
  .strictObject({
    continentCode: GeoTextSchema.optional(),
    continentName: GeoTextSchema.optional(),
    continentGeonameId: GeoNonnegativeIntegerSchema.optional(),
    countryCode: GeoTextSchema.optional(),
    countryName: GeoTextSchema.optional(),
    countryGeonameId: GeoNonnegativeIntegerSchema.optional(),
    registeredCountryCode: GeoTextSchema.optional(),
    registeredCountryName: GeoTextSchema.optional(),
    registeredCountryGeonameId: GeoNonnegativeIntegerSchema.optional(),
    regionCode: GeoTextSchema.optional(),
    regionName: GeoTextSchema.optional(),
    regionGeonameId: GeoNonnegativeIntegerSchema.optional(),
    city: GeoTextSchema.optional(),
    cityGeonameId: GeoNonnegativeIntegerSchema.optional(),
    postalCode: GeoTextSchema.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    timezone: GeoTextSchema.optional(),
    accuracyRadiusKm: GeoNonnegativeIntegerSchema.optional(),
    autonomousSystemNumber: z.number().optional(),
    autonomousSystemOrganization: GeoTextSchema.optional(),
    localizedNames: GeoLocalizedNameSetSchema.optional(),
  })
  .readonly();
export type GeoAttribution = z.infer<typeof GeoAttributionSchema>;
