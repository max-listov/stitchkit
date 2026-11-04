---
title: GeoIP
description: A server-only managed GeoIP reader with three observable states and last-known-good generation reloads.
type: guide
status: active
created: 2026-09-06
updated: 2026-11-04 19:00 +07:00
---

# GeoIP

`stitchkit/geo` is a server-only, evolving entrypoint for reading local GeoIP
databases without making a database vendor part of the framework contract. It
exposes a managed resolver, a peer-neutral reader boundary and an optional
MaxMind adapter.

## MaxMind

Install `maxmind` only in applications that use the adapter:

```bash
bun add maxmind
```

Create one resolver and place it in the application resource graph:

```ts
import { createApplication } from 'stitchkit/application';
import { createGeoIpResolver, createMaxMindGeoIpLoader } from 'stitchkit/geo';

const geo = createGeoIpResolver({
  paths: {
    city: '/srv/geo/GeoLite2-City.mmdb',
    asn: '/srv/geo/GeoLite2-ASN.mmdb',
  },
  loader: createMaxMindGeoIpLoader(),
  reload: { intervalMs: 60_000 },
  onError(error) {
    logger.warn('GeoIP reader unavailable', { error });
  },
});

const application = createApplication({ resources: [geo] });
```

The loader imports the optional peer lazily. City and optional ASN files open
as one revision: if either changes during the open, the incomplete generation
is discarded.

## Three states

`geo.snapshot()` distinguishes facts that must not be collapsed:

- `uninitialized` — the managed resource has not started, or has closed;
- `unavailable` — no usable database generation could be opened;
- `ready` — lookups use a complete generation.

A refresh failure while a reader is already `ready` preserves that reader and
sets `reloadError`. This is last-known-good service, not a successful refresh.
Applications decide whether that fact degrades their own readiness.

## Lookups

```ts
const attribution = await geo.resolve(requestIp);
```

`resolve` returns `null` for invalid, loopback, private, link-local and otherwise
non-public addresses without querying the reader. A database miss or lookup
failure also returns `null`; `onError` receives operational failures. A result
is a sparse `GeoAttribution`: absent facts have no own property, not `null` or
an own `undefined` value. City and ASN can be present independently. The default
mapper preserves the complete City + ASN place snapshot:

| Fields | Meaning |
|--------|---------|
| `continentCode`, `continentName`, `continentGeonameId` | continent code, English name and GeoNames identifier |
| `countryCode`, `countryName`, `countryGeonameId` | the country the database locates the address in; absent when the record locates none |
| `registeredCountryCode`, `registeredCountryName`, `registeredCountryGeonameId` | the country the address block is registered to, a separate fact |
| `regionCode`, `regionName`, `regionGeonameId` | first subdivision |
| `city`, `cityGeonameId`, `postalCode` | city and postal facts; no city is required |
| `latitude`, `longitude`, `timezone`, `accuracyRadiusKm` | coordinates, timezone and accuracy radius in kilometres; zero is a value |
| `autonomousSystemNumber`, `autonomousSystemOrganization` | finite autonomous system number and organisation |
| `localizedNames` | every available language under optional `continent`, `country`, `registeredCountry`, `region` and `city` dictionaries |

No locale is synthesised: without English names, localized dictionaries make a
meaningful result, but `countryName`, `regionName` or `city` stays absent. The
located country is never inferred from the registered one — an application that
wants a country for every address chooses `countryCode ?? registeredCountryCode`
itself, knowing which fact it used. Empty localized groups are omitted. Each field
is validated on its own by the schema: text is nonempty, GeoNames identifiers and
`accuracyRadiusKm` are nonnegative safe integers, latitude and longitude are in
range. A malformed field is omitted without erasing the other valid facts. Unknown
vendor fields are not projected.

A snapshot carries every language the database has: with the eight GeoLite2
languages in all five groups it is 1–1.5 KB of JSON. An application that stores
one per visit and needs fewer languages maps the result to its own shape.

`GeoAttributionSchema` is the strict, readonly Zod owner of the DTO. It lives in
the browser-safe `stitchkit/geo/contract`, so a shared contract validates a stored
or transported snapshot without the server-only resolver. Every field is optional
and readonly; use `.unwrap()` before composing the underlying object schema. The
mapper copies localized dictionaries, so later reader mutations do not change a
snapshot. An empty or unrecognised record returns `null`.

An explicit `map` callback receives the raw reader result and owns its
answer. The resolver does not apply `GeoAttributionSchema` after a custom mapper,
strip its application fields or replace its returned object.

When a reload succeeds, new lookups move to the new generation immediately.
The previous reader closes only after its in-flight lookups finish.

## A custom reader

Use `GeoIpReaderLoader` when the database is not MaxMind-compatible. `revision`
must identify the complete input generation and return `null` when it cannot be
read. `open` returns a reader for exactly that revision. Stitchkit serializes
reloads, swaps generations and owns their close lifecycle.

Download schedules, licenses, database paths, attribution persistence and
analytics policy belong to the application.
