import { expect, test } from 'bun:test';
import { type GeoAttribution, mapGeoIpRecord } from '../src/entrypoints/geo';
import { GeoAttributionSchema } from '../src/entrypoints/geo/contract';
import { GEO_ASN_RECORD, GEO_CITY_RECORD, GEO_FULL_SNAPSHOT } from './geo-snapshot.fixture';

test('maps every field and locale of a complete synthetic MaxMind City and ASN fixture', () => {
  expect(mapGeoIpRecord({ ...GEO_CITY_RECORD, ...GEO_ASN_RECORD })).toStrictEqual(
    GEO_FULL_SNAPSHOT,
  );
});

test('sparse records contain no city or own undefined values and preserve ASN alone', () => {
  const sparse = mapGeoIpRecord({
    country: { iso_code: 'TH' },
    location: { latitude: 0, longitude: -20 },
  });
  expect(sparse).toStrictEqual({ countryCode: 'TH', latitude: 0, longitude: -20 });
  expect(Object.hasOwn(sparse ?? {}, 'city')).toBe(false);
  expect(mapGeoIpRecord(GEO_ASN_RECORD)).toStrictEqual({
    autonomousSystemNumber: 64500,
    autonomousSystemOrganization: 'Example Network',
  });
  expect(Object.keys(mapGeoIpRecord(GEO_ASN_RECORD) ?? {}).sort()).toEqual([
    'autonomousSystemNumber',
    'autonomousSystemOrganization',
  ]);
});

test('the registered country never stands in for the located one', () => {
  const registered = { iso_code: 'AU', geoname_id: 3, names: { en: 'Australia' } };
  const registeredOnly = {
    registeredCountryCode: 'AU',
    registeredCountryName: 'Australia',
    registeredCountryGeonameId: 3,
    localizedNames: { registeredCountry: { en: 'Australia' } },
  };
  for (const country of [undefined, null, 42]) {
    expect(mapGeoIpRecord({ country, registered_country: registered })).toStrictEqual(
      registeredOnly,
    );
  }
  // A located country that happens to equal the registration is told apart from none.
  expect(
    mapGeoIpRecord({ country: registered, registered_country: registered })?.countryCode,
  ).toBe('AU');
  const separate = mapGeoIpRecord({
    country: { iso_code: 'TH', geoname_id: 2 },
    registered_country: registered,
  });
  expect(separate?.countryCode).toBe('TH');
  expect(separate?.countryGeonameId).toBe(2);
  expect(Object.hasOwn(separate ?? {}, 'countryName')).toBe(false);
  expect(separate?.localizedNames).toStrictEqual({ registeredCountry: { en: 'Australia' } });
  const empty = mapGeoIpRecord({ country: {}, registered_country: registered });
  expect(Object.hasOwn(empty ?? {}, 'countryCode')).toBe(false);
});

test('localized-only records preserve every actual language without inventing English names', () => {
  const result = mapGeoIpRecord({
    continent: { names: { ru: 'Азия' } },
    country: { names: { 'pt-BR': 'Tailândia' } },
    registered_country: { names: { ru: 'Австралия' } },
    subdivisions: [{ names: { fr: 'Centre' } }],
    city: { names: { 'zh-CN': '河城' } },
  });
  expect(result).toStrictEqual({
    localizedNames: {
      continent: { ru: 'Азия' },
      country: { 'pt-BR': 'Tailândia' },
      registeredCountry: { ru: 'Австралия' },
      region: { fr: 'Centre' },
      city: { 'zh-CN': '河城' },
    },
  });
  expect(Object.keys(result ?? {})).toEqual(['localizedNames']);
});

test('malformed individual fields never erase valid facts or synthesize an empty snapshot', () => {
  expect(
    mapGeoIpRecord({
      country: {
        iso_code: 'TH',
        geoname_id: 1.5,
        names: { en: 42, ru: 'Таиланд', empty: '', '': 'invalid locale' },
      },
      city: { geoname_id: NaN, names: [] },
      location: { accuracy_radius: -1, latitude: 0, longitude: -20, time_zone: '' },
      postal: { code: '' },
      autonomous_system_number: 1.5,
      traits: { ignored: true },
    }),
  ).toStrictEqual({
    countryCode: 'TH',
    latitude: 0,
    longitude: -20,
    autonomousSystemNumber: 1.5,
    localizedNames: { country: { ru: 'Таиланд' } },
  });
  for (const invalid of [
    undefined,
    null,
    42,
    [],
    {},
    { traits: {} },
    { city: { names: { en: 42, ru: '' } } },
  ]) {
    expect(mapGeoIpRecord(invalid)).toBeNull();
  }
  expect(mapGeoIpRecord({ location: { latitude: NaN, longitude: Infinity } })).toBeNull();
  expect(mapGeoIpRecord({ location: { latitude: 91, longitude: -180.5 } })).toBeNull();
  expect(mapGeoIpRecord({ autonomous_system_number: -1 })).toStrictEqual({
    autonomousSystemNumber: -1,
  });
});

test('new identifiers and accuracy radius are nonnegative safe integers with zero retained', () => {
  for (const invalid of [-1, 1.5, NaN, Infinity, '5', Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      mapGeoIpRecord({
        country: { iso_code: 'TH', geoname_id: invalid },
        location: { accuracy_radius: invalid },
      }),
    ).toStrictEqual({ countryCode: 'TH' });
  }
  expect(
    mapGeoIpRecord({ city: { geoname_id: 0 }, location: { accuracy_radius: 0 } }),
  ).toStrictEqual({ cityGeonameId: 0, accuracyRadiusKm: 0 });
});

test('the public schema preserves readonly snapshots and rejects unknown or invalid DTO fields', () => {
  expect(GeoAttributionSchema.parse(GEO_FULL_SNAPSHOT)).toStrictEqual(GEO_FULL_SNAPSHOT);
  expect(GeoAttributionSchema.parse({ countryCode: 'TH' })).toStrictEqual({
    countryCode: 'TH',
  });
  for (const invalid of [
    { city: null },
    { accuracyRadiusKm: -1 },
    { cityGeonameId: 1.5 },
    { unknown: true },
    { localizedNames: { city: { en: 42 } } },
    { city: '' },
    { localizedNames: { city: { en: '' } } },
    { localizedNames: { city: { '': 'Bangkok' } } },
    { latitude: 999 },
    { longitude: -181 },
  ]) {
    expect(GeoAttributionSchema.safeParse(invalid).success).toBe(false);
  }
  const source = { city: { names: { en: 'Before', ru: 'До' } } };
  const snapshot = mapGeoIpRecord(source);
  source.city.names.en = 'After';
  expect(snapshot).toStrictEqual({
    city: 'Before',
    localizedNames: { city: { en: 'Before', ru: 'До' } },
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot?.localizedNames?.city)).toBe(true);
});

function readonlyGeoChecks(snapshot: GeoAttribution) {
  // @ts-expect-error existing top-level attribution remains readonly
  snapshot.countryCode = 'AU';
  if (snapshot.localizedNames?.city) {
    // @ts-expect-error localized snapshot dictionaries are readonly too
    snapshot.localizedNames.city.en = 'Changed';
  }
}
void readonlyGeoChecks;

test('the mapper keeps a field exactly when the public schema accepts it', () => {
  const paths: Record<string, (value: unknown) => Record<string, unknown>> = {
    countryCode: (value) => ({ country: { iso_code: value } }),
    countryGeonameId: (value) => ({ country: { geoname_id: value } }),
    city: (value) => ({ city: { names: { en: value } } }),
    postalCode: (value) => ({ postal: { code: value } }),
    latitude: (value) => ({ location: { latitude: value } }),
    longitude: (value) => ({ location: { longitude: value } }),
    timezone: (value) => ({ location: { time_zone: value } }),
    accuracyRadiusKm: (value) => ({ location: { accuracy_radius: value } }),
    autonomousSystemNumber: (value) => ({ autonomous_system_number: value }),
  };
  const values = ['', 'TH', 0, -1, 1.5, 90, 91, -180, -181, 999, NaN, Infinity, '5', null];
  for (const [name, source] of Object.entries(paths)) {
    for (const value of values) {
      const accepted = GeoAttributionSchema.safeParse({ [name]: value }).success;
      const mapped = mapGeoIpRecord({ traits: {}, ...source(value) });
      expect([name, value, Object.hasOwn(mapped ?? {}, name)]).toEqual([
        name,
        value,
        accepted,
      ]);
    }
  }
});
