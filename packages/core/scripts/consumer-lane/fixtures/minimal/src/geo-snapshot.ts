import { mapGeoIpRecord } from 'stitchkit/geo';
import { type GeoAttribution, GeoAttributionSchema } from 'stitchkit/geo/contract';

/** The packed snapshot keeps zero, every locale and the registered country as its own fact. */
const geo: GeoAttribution = GeoAttributionSchema.parse(
  mapGeoIpRecord({
    registered_country: { iso_code: 'AU', geoname_id: 3 },
    city: { names: { ru: 'Город' } },
    location: { accuracy_radius: 0 },
  }),
);
if (
  geo.registeredCountryGeonameId !== 3 ||
  geo.accuracyRadiusKm !== 0 ||
  geo.localizedNames?.city?.ru !== 'Город'
) {
  throw new Error('Packed GeoIP snapshot lost fields or locales');
}
if (Object.hasOwn(geo, 'countryCode')) {
  throw new Error('Packed GeoIP snapshot took the registered country for the located one');
}
if (Object.hasOwn(geo, 'city')) throw new Error('Packed GeoIP snapshot invented a city label');
