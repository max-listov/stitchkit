/**
 * Guard: `isPublicIp` answers "may this address be handed to something outside
 * this process", and refuses everything it cannot read.
 *
 * Two consuming applications carry the same reserved-range table. The ranges
 * that get left out of a hand-written one are never `10/8` — they are
 * carrier-grade NAT, which is a real client address nothing routes back to, and
 * `169.254/16`, which is what a host says when DHCP failed.
 */
import { describe, expect, test } from 'bun:test';
import { extractIp, isPublicIp } from '../src/server';

describe('public IPv4', () => {
  test('routable addresses are public', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '203.0.114.1',
      '100.63.255.255',
      '99.1.2.3',
    ]) {
      expect(isPublicIp(address)).toBe(true);
    }
  });

  test('every reserved block is refused, including the forgettable ones', () => {
    const reserved = [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1', // carrier-grade NAT — a client address with no route back
      '100.127.255.255',
      '127.0.0.1',
      '169.254.1.1', // what a host answers with when DHCP failed
      '172.16.0.1',
      '172.31.255.255',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
    ];
    for (const address of reserved) expect(isPublicIp(address)).toBe(false);
  });

  test('the edges of a block are on the right side of it', () => {
    // `172.16/12` is the one a hand-written table gets wrong, because the
    // boundary is not on a dotted-quad edge.
    expect(isPublicIp('172.15.255.255')).toBe(true);
    expect(isPublicIp('172.32.0.0')).toBe(true);
    expect(isPublicIp('172.16.0.0')).toBe(false);
    expect(isPublicIp('172.31.255.255')).toBe(false);
    // `240/4` reaches the broadcast address, and a signed shift would read the
    // whole block as negative and let it through.
    expect(isPublicIp('239.255.255.255')).toBe(false);
    expect(isPublicIp('223.255.255.255')).toBe(true);
  });
});

describe('public IPv6', () => {
  test('global unicast is public and everything outside it is not', () => {
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('2400:cb00::1')).toBe(true);
    for (const address of [
      '::',
      '::1',
      'fe80::1',
      'fe80::1%eth0', // a zone names an interface, not another address
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '100::1',
      '2001:db8::1', // documentation
      '2001::1', // IETF assignments, inside global unicast and still not public
    ]) {
      expect(isPublicIp(address)).toBe(false);
    }
  });

  test('an IPv4-mapped address is judged as the address it carries', () => {
    // The mapping is notation. `::ffff:10.0.0.1` is a LAN host either way, and
    // it is exactly the form a socket peer arrives in on a dual-stack listener.
    expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicIp('::ffff:0808:0808')).toBe(true);
  });

  test('compressed and full forms of one address agree', () => {
    expect(isPublicIp('2606:4700:0000:0000:0000:0000:0000:1111')).toBe(true);
    expect(isPublicIp('2606:4700::1111')).toBe(true);
    expect(isPublicIp('fe80:0000:0000:0000:0000:0000:0000:0001')).toBe(false);
  });
});

describe('what it will not affirm', () => {
  test('anything unparseable is not public', () => {
    // The honest answer to "is this a public peer" for a value nobody can read
    // is no. A `true` here would be safe by accident until the first malformed
    // header, which is the case the function exists for.
    for (const value of [
      '',
      '   ',
      'example.com',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '010.0.0.1', // octal to some resolvers, decimal to others
      '1:2:3',
      '1::2::3',
      ':::',
      'gggg::1',
      '2606:4700:4700::11111',
    ]) {
      expect(isPublicIp(value)).toBe(false);
    }
  });

  test('it reads what extractIp produces, including the empty answer', () => {
    const request = new Request('https://example.test/', {
      headers: { 'x-forwarded-for': '203.0.114.9, 10.0.0.1' },
    });
    expect(isPublicIp(extractIp(request, { trustProxy: true }))).toBe(true);
    // Nothing known is not a public peer either.
    expect(isPublicIp(extractIp(request))).toBe(false);
  });
});
