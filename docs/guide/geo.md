---
title: GeoIP
description: A server-only managed GeoIP reader with three observable states and last-known-good generation reloads.
type: guide
status: active
created: 2026-09-06
updated: 2026-09-06
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
may include country, region, city, postal, coordinates, timezone and ASN fields.

When a reload succeeds, new lookups move to the new generation immediately.
The previous reader closes only after its in-flight lookups finish.

## A custom reader

Use `GeoIpReaderLoader` when the database is not MaxMind-compatible. `revision`
must identify the complete input generation and return `null` when it cannot be
read. `open` returns a reader for exactly that revision. Stitchkit serializes
reloads, swaps generations and owns their close lifecycle.

Download schedules, licenses, database paths, attribution persistence and
analytics policy belong to the application.
