import { describe, expect, test } from 'bun:test';
import { checkCliUpdate } from '../src/tools/cli-update';

/**
 * A self-hosted deployment serves its manifest from its own network. The check
 * has a switch for that; the refusal has to say so, or "could not ask" reads
 * like a timeout and the deployment goes quietly stale.
 */
describe('a manifest on a private endpoint', () => {
  test('is refused with the remedy named, not with a bare guard message', async () => {
    const check = await checkCliUpdate({
      manifestUrl: 'http://10.0.0.7/manifest.json',
      currentVersion: '1.0.0',
    });
    expect(check.status).toBe('unknown');
    const reason = check.status === 'unknown' ? check.reason : '';
    expect(reason).toContain('allowPrivateHosts');
    expect(reason).toContain('not public');
  });

  test('localhost is refused the same way', async () => {
    const check = await checkCliUpdate({
      manifestUrl: 'http://localhost:9/manifest.json',
      currentVersion: '1.0.0',
    });
    expect(check.status === 'unknown' && check.reason).toContain('allowPrivateHosts');
  });

  test('a refusal the switch cannot lift keeps its own reason', async () => {
    // A scheme the boundary rejects is not an address-privacy refusal, and
    // `allowPrivateHosts` would not lift it. Offering it there would send a
    // reader to a field that cannot help.
    const check = await checkCliUpdate({
      manifestUrl: 'ftp://releases.example.com/manifest.json',
      currentVersion: '1.0.0',
    });
    expect(check.status).toBe('unknown');
    expect(check.status === 'unknown' && check.reason).not.toContain('allowPrivateHosts');
  });

  test('with the switch on, the guard is no longer what stops it', async () => {
    const check = await checkCliUpdate({
      manifestUrl: 'http://127.0.0.1:9/manifest.json',
      currentVersion: '1.0.0',
      allowPrivateHosts: true,
      timeoutMs: 250,
    });
    expect(check.status).toBe('unknown');
    expect(check.status === 'unknown' && check.reason).not.toContain('allowPrivateHosts');
  });
});
