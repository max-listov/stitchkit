import { describe, expect, test } from 'bun:test';
import { developmentEnvironment } from './dev';
import { privateLanAddresses, selectLanAddress } from './dev-lan';

describe('LAN HTTPS address selection', () => {
  test('normal development clears every LAN-only process variable', () => {
    expect(developmentEnvironment()).toMatchObject({
      DEV_HTTPS_CA: '',
      DEV_HTTPS_CERT: '',
      DEV_HTTPS_KEY: '',
      NODE_EXTRA_CA_CERTS: '',
    });
    expect(developmentEnvironment({ DEV_HTTPS_CERT: '/cert.pem' }).DEV_HTTPS_CERT).toBe(
      '/cert.pem',
    );
  });

  test('keeps private IPv4 interfaces and ignores public/internal addresses', () => {
    expect(
      privateLanAddresses({
        eth0: [
          {
            address: '192.168.1.20',
            netmask: '',
            family: 'IPv4',
            mac: '',
            internal: false,
            cidr: null,
          },
          {
            address: '8.8.8.8',
            netmask: '',
            family: 'IPv4',
            mac: '',
            internal: false,
            cidr: null,
          },
        ],
        lo: [
          {
            address: '127.0.0.1',
            netmask: '',
            family: 'IPv4',
            mac: '',
            internal: true,
            cidr: null,
          },
        ],
      }),
    ).toEqual(['192.168.1.20']);
  });

  test('auto-selects one address and fails on ambiguity', () => {
    expect(selectLanAddress(['10.0.0.4'])).toBe('10.0.0.4');
    expect(() => selectLanAddress(['10.0.0.4', '192.168.1.20'])).toThrow('ambiguous');
    expect(() => selectLanAddress(['10.0.0.4'], '10.0.0.5')).toThrow('unavailable');
  });
});
