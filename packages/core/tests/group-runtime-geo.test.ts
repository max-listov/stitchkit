import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeoIpResolver, createMaxMindGeoIpLoader, mapGeoIpRecord } from '../src/geo';
import type { GeoIpReader } from '../src/geo/types';

describe('GeoIP resolver generations', () => {
  test('has three states, rejects non-public IPs, and atomically swaps generations', async () => {
    let revision: string | null = null;
    let generation = 0;
    const closed: number[] = [];
    const resolver = createGeoIpResolver({
      paths: { city: '/db/city.mmdb' },
      loader: {
        revision: () => revision,
        open: (): GeoIpReader => {
          const own = ++generation;
          return {
            lookup: () => ({ country: { iso_code: `G${own}` } }),
            close: () => {
              closed.push(own);
            },
          };
        },
      },
      reload: false,
    });
    expect(resolver.snapshot().state).toBe('uninitialized');
    await resolver.start({} as never);
    expect(resolver.snapshot().state).toBe('unavailable');
    expect(await resolver.resolve('127.0.0.1')).toBeNull();

    revision = 'one';
    expect(await resolver.reload()).toBe(true);
    expect(await resolver.resolve('8.8.8.8')).toEqual({ countryCode: 'G1' });
    revision = 'two';
    expect(await resolver.reload()).toBe(true);
    expect(closed).toEqual([1]);
    expect(await resolver.resolve('8.8.8.8')).toEqual({ countryCode: 'G2' });
  });

  test('keeps last-known-good when a reload degrades', async () => {
    let fail = false;
    const resolver = createGeoIpResolver({
      paths: {},
      loader: {
        revision: () => (fail ? 'broken' : 'good'),
        open: () => {
          if (fail) throw new Error('corrupt generation');
          return { lookup: () => ({ city: { names: { en: 'Bangkok' } } }) };
        },
      },
      reload: false,
    });
    await resolver.start({} as never);
    fail = true;
    expect(await resolver.reload()).toBe(false);
    expect(resolver.snapshot()).toMatchObject({
      state: 'ready',
      reloadError: 'corrupt generation',
    });
    expect(await resolver.resolve('1.1.1.1')).toEqual({ city: 'Bangkok' });
  });

  test('does not close a retired generation before its in-flight lookup settles', async () => {
    let revision = 'one';
    let releaseLookup: () => void = () => undefined;
    let closed = false;
    const resolver = createGeoIpResolver({
      paths: {},
      loader: {
        revision: () => revision,
        open: () => ({
          lookup: () =>
            revision === 'one'
              ? new Promise((resolve) => {
                  releaseLookup = () => resolve({ country: { iso_code: 'TH' } });
                })
              : { country: { iso_code: 'US' } },
          close: () => {
            closed = true;
          },
        }),
      },
      reload: false,
    });
    await resolver.start({} as never);
    const lookup = resolver.resolve('8.8.8.8');
    revision = 'two';
    const reload = resolver.reload();
    await Bun.sleep(0);
    expect(closed).toBe(false);
    releaseLookup();
    expect(await lookup).toEqual({ countryCode: 'TH' });
    await reload;
    expect(closed).toBe(true);
  });

  test('maps only the generic optional attribution superset', () => {
    expect(
      mapGeoIpRecord({
        country: { iso_code: 'TH', names: { en: 'Thailand' } },
        location: { latitude: 13.7, longitude: 100.5, time_zone: 'Asia/Bangkok' },
      }),
    ).toEqual({
      countryCode: 'TH',
      countryName: 'Thailand',
      latitude: 13.7,
      longitude: 100.5,
      timezone: 'Asia/Bangkok',
    });
  });

  test('opens City and ASN as one stable optional-peer generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-geo-'));
    const cityPath = join(directory, 'city.mmdb');
    const asnPath = join(directory, 'asn.mmdb');
    await Promise.all([writeFile(cityPath, 'city'), writeFile(asnPath, 'asn')]);
    const closed: string[] = [];
    const loader = createMaxMindGeoIpLoader({
      loadPeer: async () => ({
        open: async (path: string) => ({
          get: () =>
            path === cityPath
              ? { country: { iso_code: 'TH' } }
              : {
                  autonomous_system_number: 13_335,
                  autonomous_system_organization: 'Cloudflare',
                },
          close: () => closed.push(path),
        }),
      }),
    });
    try {
      const expectedRevision = await loader.revision({ city: cityPath, asn: asnPath });
      if (expectedRevision === null) throw new Error('expected GeoIP fixture revision');
      const reader = await loader.open({ city: cityPath, asn: asnPath }, expectedRevision);
      expect(mapGeoIpRecord(await reader.lookup('1.1.1.1'))).toEqual({
        countryCode: 'TH',
        autonomousSystemNumber: 13_335,
        autonomousSystemOrganization: 'Cloudflare',
      });
      await reader.close?.();
      expect(closed.sort()).toEqual([asnPath, cityPath].sort());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('never labels a reader with a revision that moved before open', async () => {
    let revision = 'one';
    const resolver = createGeoIpResolver({
      paths: {},
      loader: {
        revision: () => revision,
        open: (_paths, expectedRevision) => {
          revision = 'two';
          if (expectedRevision !== revision) throw new Error('generation moved');
          return { lookup: () => ({ country: { iso_code: 'TH' } }) };
        },
      },
      reload: false,
    });
    await resolver.start({} as never);
    expect(resolver.snapshot()).toMatchObject({
      state: 'unavailable',
      reloadError: 'generation moved',
    });
    expect(await resolver.reload()).toBe(true);
    expect(resolver.snapshot()).toMatchObject({ state: 'ready', revision: 'two' });
  });
});
