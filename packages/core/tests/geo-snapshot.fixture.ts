export const GEO_CITY_RECORD = {
  continent: { code: 'AS', geoname_id: 1, names: { en: 'Asia', ru: 'Азия' } },
  country: { iso_code: 'TH', geoname_id: 2, names: { en: 'Thailand', ru: 'Таиланд' } },
  registered_country: {
    iso_code: 'AU',
    geoname_id: 3,
    names: { en: 'Australia', ru: 'Австралия' },
  },
  subdivisions: [
    { iso_code: '10', geoname_id: 4, names: { en: 'Central', ru: 'Центральный' } },
    { iso_code: 'ignored', names: { en: 'Second subdivision' } },
  ],
  city: { geoname_id: 5, names: { en: 'River City', ru: 'Речной город', 'zh-CN': '河城' } },
  postal: { code: '10110' },
  location: { latitude: 0, longitude: 100.5, accuracy_radius: 0, time_zone: 'Asia/Bangkok' },
};

export const GEO_ASN_RECORD = {
  autonomous_system_number: 64500,
  autonomous_system_organization: 'Example Network',
};

export const GEO_FULL_SNAPSHOT = {
  continentCode: 'AS',
  continentName: 'Asia',
  continentGeonameId: 1,
  countryCode: 'TH',
  countryName: 'Thailand',
  countryGeonameId: 2,
  registeredCountryCode: 'AU',
  registeredCountryName: 'Australia',
  registeredCountryGeonameId: 3,
  regionCode: '10',
  regionName: 'Central',
  regionGeonameId: 4,
  city: 'River City',
  cityGeonameId: 5,
  postalCode: '10110',
  latitude: 0,
  longitude: 100.5,
  accuracyRadiusKm: 0,
  timezone: 'Asia/Bangkok',
  autonomousSystemNumber: 64500,
  autonomousSystemOrganization: 'Example Network',
  localizedNames: {
    continent: { en: 'Asia', ru: 'Азия' },
    country: { en: 'Thailand', ru: 'Таиланд' },
    registeredCountry: { en: 'Australia', ru: 'Австралия' },
    region: { en: 'Central', ru: 'Центральный' },
    city: { en: 'River City', ru: 'Речной город', 'zh-CN': '河城' },
  },
};
