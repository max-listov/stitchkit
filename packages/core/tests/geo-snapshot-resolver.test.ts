import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeoIpResolver, createMaxMindGeoIpLoader } from '../src/entrypoints/geo';
import { GEO_ASN_RECORD, GEO_CITY_RECORD, GEO_FULL_SNAPSHOT } from './geo-snapshot.fixture';
import { resourceContext } from './session-delivery-fixture';

test('fake-peer City and ASN generation delivers full and sparse snapshots through the public resolver', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stitchkit-geo-snapshot-'));
  const paths = { city: join(directory, 'city.mmdb'), asn: join(directory, 'asn.mmdb') };
  await Promise.all([
    writeFile(paths.city, 'fake city revision'),
    writeFile(paths.asn, 'fake ASN revision'),
  ]);
  let city: unknown = GEO_CITY_RECORD;
  let asn: unknown = GEO_ASN_RECORD;
  const opened: string[] = [];
  const closed: string[] = [];
  const lookups: string[] = [];
  const errors: unknown[] = [];
  let peerLoads = 0;
  const loader = createMaxMindGeoIpLoader({
    loadPeer: async () => {
      peerLoads += 1;
      return {
        open: async (path: string) => {
          opened.push(path);
          return {
            get: (ip: string) => {
              lookups.push(ip);
              return path === paths.city ? city : asn;
            },
            close: () => {
              closed.push(path);
            },
          };
        },
      };
    },
  });
  const resolver = createGeoIpResolver({
    paths,
    loader,
    reload: false,
    onError: (error) => {
      errors.push(error);
    },
  });
  try {
    expect(peerLoads).toBe(0);
    await resolver.start(resourceContext());
    expect(resolver.snapshot().state).toBe('ready');
    const generation = resolver.snapshot().revision;
    expect(await resolver.resolve('127.0.0.1')).toBeNull();
    expect(lookups).toEqual([]);
    expect(await resolver.resolve('8.8.8.8')).toStrictEqual(GEO_FULL_SNAPSHOT);
    expect(lookups).toEqual(['8.8.8.8', '8.8.8.8']);
    city = null;
    expect(await resolver.resolve('8.8.8.8')).toStrictEqual({
      autonomousSystemNumber: 64500,
      autonomousSystemOrganization: 'Example Network',
    });
    asn = null;
    expect(await resolver.resolve('8.8.8.8')).toBeNull();
    city = { city: { names: { ru: 'Речной город' } } };
    expect(await resolver.resolve('8.8.8.8')).toStrictEqual({
      localizedNames: { city: { ru: 'Речной город' } },
    });
    expect(resolver.snapshot().revision).toBe(generation);
    expect(peerLoads).toBe(1);
    expect(opened).toEqual([paths.city, paths.asn]);
    expect(errors).toEqual([]);
  } finally {
    await resolver.close?.(resourceContext());
    await rm(directory, { recursive: true, force: true });
  }
  expect(closed.sort()).toEqual([paths.city, paths.asn].sort());
});

test('custom mapper identity and extras remain untouched while lookup errors stay observable', async () => {
  const mapped = { countryCode: 'custom', applicationField: 'preserved' };
  const raw = { vendorField: 'untouched' };
  const errors: unknown[] = [];
  let fail = false;
  let mappedInput: unknown;
  const resolver = createGeoIpResolver({
    paths: {},
    reload: false,
    loader: {
      revision: () => 'custom',
      open: () => ({
        lookup: () => {
          if (fail) throw new Error('lookup failed');
          return raw;
        },
      }),
    },
    map: (record) => {
      mappedInput = record;
      return mapped;
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  try {
    await resolver.start(resourceContext());
    expect(await resolver.resolve('8.8.8.8')).toBe(mapped);
    expect(mappedInput).toBe(raw);
    fail = true;
    expect(await resolver.resolve('8.8.8.8')).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(resolver.snapshot().state).toBe('ready');
  } finally {
    await resolver.close?.(resourceContext());
  }
});
