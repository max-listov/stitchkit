import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { createSessionScope, SessionExpiredError } from '../src/browser/session';
import { createSessionCredentials } from '../src/browser/session-credentials';
import { defineContract } from '../src/contract/define';
import { until } from './session-delivery-fixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const contract = defineContract(
  { prefix: 'probe' },
  {
    read: { method: 'GET', path: '/', desc: 'Read', output: z.object({ value: z.string() }) },
  },
);

test('published-client transport path fences HTTP, relogin and final success/error delivery', async () => {
  const arrived = deferred<void>();
  const release = deferred<void>();
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      arrived.resolve();
      await release.promise;
      return Response.json({ value: 'old' });
    },
  });
  try {
    const scope = createSessionScope<string>();
    const old = scope.replace('A');
    const client = createClient(
      contract,
      createHttpClient({
        baseUrl: server.url.href,
        retry: { limit: 0 },
        fetch: old.bindFetch(fetch, () => ({ Authorization: 'old-token' })),
      }),
    );
    const pending = old.run(() => client.read()).catch((e) => e);
    await arrived.promise;
    scope.replace('A');
    release.resolve();
    expect(await pending).toBeInstanceOf(SessionExpiredError);
    expect(
      old.deliver(() => {
        throw new Error('late delivery');
      }),
    ).toBe(false);
    await expect(old.run(() => client.read())).rejects.toBeInstanceOf(SessionExpiredError);
    expect(requests).toBe(1);
    const current = scope.capture();
    expect(await current.run(() => 7)).toBe(7);
    let delivered = 0;
    expect(
      current.deliver(() => {
        delivered++;
      }),
    ).toBe(true);
    expect(delivered).toBe(1);
    scope.stop();
    expect(current.current()).toBe(false);
    expect(() => scope.replace('B')).toThrow(SessionExpiredError);
  } finally {
    release.resolve();
    server.stop(true);
  }
});

test('late rejection and guarded token supplier cannot cross account or logout', async () => {
  for (const change of ['B', 'logout']) {
    const scope = createSessionScope<string>();
    const op = scope.replace('A');
    const pending = deferred<void>();
    const result = op.run(() => pending.promise).catch((e) => e);
    if (change === 'logout') scope.clear();
    else scope.replace(change);
    pending.reject(new Error('old private failure'));
    expect(await result).toBeInstanceOf(SessionExpiredError);
    let tokens = 0;
    await expect(
      op.bindFetch(fetch, () => {
        tokens++;
        return {};
      })('http://unused'),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(tokens).toBe(0);
  }
});

test('credentials refresh is shared per generation and an old flight cannot clear the new one', async () => {
  const scope = createSessionScope<string>();
  const oldRefresh = deferred<string>();
  const newRefresh = deferred<string>();
  let calls = 0;
  let stored: string | undefined;
  const auth = createSessionCredentials({
    scope,
    refresh: () => {
      calls++;
      return calls === 1 ? oldRefresh.promise : newRefresh.promise;
    },
    storage: {
      async read() {
        return stored === undefined ? null : { session: 'A', credentials: stored };
      },
      async write(_, value) {
        stored = value;
      },
      async clear() {
        stored = undefined;
      },
    },
  });
  const a = await auth.login('A', 'a');
  const first = auth.refresh(a);
  expect(auth.refresh(a)).toBe(first);
  const firstError = first.catch((e) => e);
  const b = await auth.login('B', 'b');
  const second = auth.refresh(b);
  expect(await firstError).toBeInstanceOf(SessionExpiredError);
  oldRefresh.resolve('stale');
  await Promise.resolve();
  expect(auth.refresh(b)).toBe(second);
  expect(calls).toBe(2);
  newRefresh.resolve('new');
  expect(await second).toBe('new');
  expect(stored).toBe('new');
  expect(() => auth.read(a)).toThrow(SessionExpiredError);
});

test('logout orders an already-started storage write and cannot erase a newer login', async () => {
  const scope = createSessionScope<string>();
  const started = deferred<void>();
  const finish = deferred<void>();
  let block = false;
  let stored: string | undefined;
  const auth = createSessionCredentials({
    scope,
    refresh: async () => 'refreshed',
    storage: {
      read: async () => null,
      async write(_, value) {
        if (block) {
          started.resolve();
          await finish.promise;
        }
        stored = value;
      },
      async clear() {
        stored = undefined;
      },
    },
  });
  const a = await auth.login('A', 'a');
  block = true;
  const refresh = auth.refresh(a).catch((e) => e);
  await started.promise;
  const logout = auth.logout();
  expect(a.current()).toBe(false);
  block = false;
  const login = auth.login('A', 'new-a');
  finish.resolve();
  expect(await refresh).toBeInstanceOf(SessionExpiredError);
  await logout;
  const next = await login;
  expect(stored).toBe('new-a');
  expect(auth.read(next)).toBe('new-a');
  await auth.logout();
  expect(stored).toBeUndefined();
});

test('storage failure is visible and does not poison the queue; a hung HTTP does not hold logout', async () => {
  const scope = createSessionScope<string>();
  let fail = true;
  const auth = createSessionCredentials({
    scope,
    refreshTimeoutMs: 1000,
    refresh: () => new Promise<string>(() => undefined),
    storage: {
      read: async () => null,
      async write() {
        if (fail) throw new Error('storage unavailable');
      },
      async clear() {
        /* Fixture intentionally performs no work. */
      },
    },
  });
  await expect(auth.login('A', 'a')).rejects.toThrow('storage unavailable');
  fail = false;
  const a = await auth.login('A', 'a');
  const result = auth.refresh(a).catch((e) => e);
  await auth.logout();
  expect(await result).toBeInstanceOf(SessionExpiredError);
});

test('an explicit single auth retry uses refreshed credentials through a real HTTP client', async () => {
  let refreshes = 0;
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/refresh') {
        refreshes++;
        return Response.json({ token: 'fresh' });
      }
      requests++;
      return request.headers.get('Authorization') === 'fresh'
        ? Response.json({ value: 'ok' })
        : Response.json(
            { error: { code: 'TOKEN_EXPIRED', message: 'Expired' } },
            { status: 401 },
          );
    },
  });
  try {
    const scope = createSessionScope<string>();
    const auth = createSessionCredentials<string, string>({
      scope,
      refresh: async (_, signal) => {
        const response = await fetch(new URL('/refresh', server.url), {
          method: 'POST',
          signal,
        });
        return z.object({ token: z.string() }).parse(await response.json()).token;
      },
      storage: {
        read: async () => null,
        write: async () => undefined,
        clear: async () => undefined,
      },
    });
    const operation = await auth.login('A', 'expired');
    const client = createClient(contract, {
      baseUrl: server.url.href,
      fetch: operation.bindFetch(fetch, () => ({ Authorization: auth.read(operation) })),
    });
    let value: { value: string };
    try {
      value = await operation.run(() => client.read());
    } catch (error) {
      operation.assertCurrent();
      if (!(error instanceof Error) || !('status' in error) || error.status !== 401)
        throw error;
      await auth.refresh(operation);
      value = await operation.run(() => client.read());
    }
    expect(value).toEqual({ value: 'ok' });
    expect(requests).toBe(2);
    expect(refreshes).toBe(1);
  } finally {
    server.stop(true);
  }
});

test('credential write capacity and refresh deadline refuse bounded work visibly', async () => {
  const scope = createSessionScope<string>();
  const storage = deferred<void>();
  const auth = createSessionCredentials({
    scope,
    maxPendingWrites: 1,
    refreshTimeoutMs: 5,
    refresh: () => new Promise<string>(() => undefined),
    storage: {
      read: async () => null,
      write: () => storage.promise,
      clear: async () => undefined,
    },
  });
  const pending = auth.login('A', 'a').catch((error) => error);
  await expect(auth.login('B', 'b')).rejects.toThrow('capacity');
  storage.resolve();
  expect(await pending).toBeInstanceOf(SessionExpiredError);
  const current = await auth.login('B', 'b');
  await expect(auth.refresh(current)).rejects.toThrow('Refresh timed out');
  expect(auth.read(current)).toBe('b');
});

test('an expired session keeps the failure that stopped its work as the cause', async () => {
  const scope = createSessionScope<string>();
  const op = scope.replace('A');
  const pending = deferred<void>();
  const result = op.run(() => pending.promise).catch((e) => e);
  scope.clear();
  const failure = new Error('upstream refused');
  pending.reject(failure);
  const error = await result;
  expect(error).toBeInstanceOf(SessionExpiredError);
  expect(error.cause).toBe(failure);
});

test('a storage write that hangs does not keep logout from clearing, and a late write is undone', async () => {
  const scope = createSessionScope<string>();
  const hung = deferred<void>();
  const writing = deferred<void>();
  const landed = deferred<void>();
  let stored: string | undefined;
  let hang = false;
  const auth = createSessionCredentials({
    scope,
    storageTimeoutMs: 20,
    refresh: async () => 'refreshed',
    storage: {
      read: async () => null,
      async write(_, value) {
        if (hang) {
          hang = false;
          writing.resolve();
          await hung.promise;
          stored = value;
          landed.resolve();
          return;
        }
        stored = value;
      },
      async clear() {
        stored = undefined;
      },
    },
  });
  const a = await auth.login('A', 'a');
  hang = true;
  const refresh = auth.refresh(a).catch((e) => e);
  await writing.promise;
  await auth.logout();
  expect(stored).toBeUndefined();
  expect(await refresh).toBeInstanceOf(SessionExpiredError);
  // The hung write lands after the logout that cleared it: it is cleared again.
  hung.resolve();
  await landed.promise;
  expect(stored).toBe('refreshed');
  await until(() => stored === undefined);
});

test('a refresh whose store is slow keeps the issued credentials, and a slow store converges', async () => {
  const scope = createSessionScope<string>();
  let stored: string | undefined;
  let writes = 0;
  let slow = false;
  const storageEvents: string[] = [];
  const auth = createSessionCredentials({
    scope,
    storageTimeoutMs: 5,
    onEvent: (event) => storageEvents.push(event.type),
    refresh: async () => 'new-token',
    storage: {
      read: async () => (stored === undefined ? null : { session: 'A', credentials: stored }),
      async write(_, value) {
        writes++;
        if (slow) await Bun.sleep(20);
        stored = value;
      },
      async clear() {
        stored = undefined;
      },
    },
  });
  const a = await auth.login('A', 'old-token');
  slow = true;
  // The server already rotated the credential: refresh resolves with the new pair,
  // reports storage-failed, and lets storage converge without repeating the rotation.
  expect(await auth.refresh(a)).toBe('new-token');
  expect(storageEvents).toEqual(['storage-failed', 'refreshed']);
  // The server issued the new pair; memory holds it and storage ends with it.
  expect(auth.read(a)).toBe('new-token');
  await until(() => stored === 'new-token');
  const settled = writes;
  await Bun.sleep(100);
  expect(writes).toBe(settled);
});

test('failed login storage.write rolls back the scope, credentials and mid-flight capture', async () => {
  const scope = createSessionScope<string>();
  const writing = deferred<void>();
  const finish = deferred<void>();
  const auth = createSessionCredentials({
    scope,
    refreshAhead: { expiresAt: () => 0, leadMs: 1_000 },
    refresh: async () => 'refreshed',
    storage: {
      read: async () => null,
      async write() {
        writing.resolve();
        await finish.promise;
      },
      clear: async () => undefined,
    },
  });
  const pendingLogin = auth.login('A', 'a');
  await writing.promise;
  const midOp = scope.capture();
  expect(midOp.current()).toBe(true);
  finish.reject(new Error('storage unavailable'));
  await expect(pendingLogin).rejects.toThrow('storage unavailable');
  expect(midOp.current()).toBe(false);
  expect(() => scope.capture()).toThrow(SessionExpiredError);
  expect(() => auth.read(midOp)).toThrow(SessionExpiredError);
  await expect(auth.refreshIfDue(midOp)).rejects.toBeInstanceOf(SessionExpiredError);
});

test('failed login rollback does not clobber a concurrent newer login', async () => {
  const scope = createSessionScope<string>();
  const writeAStarted = deferred<void>();
  const writeAGate = deferred<void>();
  let stored: string | undefined;
  const auth = createSessionCredentials({
    scope,
    maxPendingWrites: 4,
    refresh: async () => 'refreshed',
    storage: {
      read: async () => (stored === undefined ? null : { session: 'B', credentials: stored }),
      async write(session, value) {
        if (session === 'A') {
          writeAStarted.resolve();
          await writeAGate.promise;
        }
        stored = value;
      },
      async clear() {
        stored = undefined;
      },
    },
  });
  const loginA = auth.login('A', 'a').catch((error) => error);
  await writeAStarted.promise;
  const loginB = auth.login('B', 'b');
  const writeAFailure = new Error('write A failed');
  writeAGate.reject(writeAFailure);

  const errorA = await loginA;
  expect(errorA).toBeInstanceOf(SessionExpiredError);
  if (!(errorA instanceof SessionExpiredError)) {
    throw new Error('Expected SessionExpiredError');
  }
  expect(errorA.cause).toBe(writeAFailure);

  const opB = await loginB;
  expect(opB.current()).toBe(true);
  expect(scope.capture()).toBe(opB);
  expect(auth.read(opB)).toBe('b');
  expect(stored).toBe('b');
});

test('failed login after logout does not bump scope generation or skip logout storage.clear', async () => {
  const scope = createSessionScope<string>();
  const writeStarted = deferred<void>();
  const writeGate = deferred<void>();
  let clears = 0;
  const auth = createSessionCredentials({
    scope,
    refresh: async () => 'refreshed',
    storage: {
      read: async () => null,
      async write() {
        writeStarted.resolve();
        await writeGate.promise;
      },
      async clear() {
        clears++;
      },
    },
  });
  const loginA = auth.login('A', 'a').catch((error) => error);
  await writeStarted.promise;
  const logoutPromise = auth.logout();
  const generationAfterLogout = scope.generation;
  const writeFailure = new Error('disk full');
  writeGate.reject(writeFailure);

  const errorA = await loginA;
  expect(errorA).toBeInstanceOf(SessionExpiredError);
  if (!(errorA instanceof SessionExpiredError)) {
    throw new Error('Expected SessionExpiredError');
  }
  expect(errorA.cause).toBe(writeFailure);
  await logoutPromise;
  expect(scope.generation).toBe(generationAfterLogout);
  expect(clears).toBe(1);
});

test('a login whose storage write times out rolls back and clears a late-landing write', async () => {
  const scope = createSessionScope<string>();
  const hung = deferred<void>();
  const writing = deferred<void>();
  const landed = deferred<void>();
  let stored: string | undefined;
  let clears = 0;
  const auth = createSessionCredentials({
    scope,
    storageTimeoutMs: 20,
    refresh: async () => 'refreshed',
    storage: {
      read: async () => null,
      async write(_, value) {
        writing.resolve();
        await hung.promise;
        stored = value;
        landed.resolve();
      },
      async clear() {
        clears++;
        stored = undefined;
      },
    },
  });
  const pendingLogin = auth.login('A', 'a');
  await writing.promise;
  const midOp = scope.capture();
  await expect(pendingLogin).rejects.toThrow('storageTimeoutMs');
  expect(midOp.current()).toBe(false);
  expect(() => scope.capture()).toThrow(SessionExpiredError);
  expect(() => auth.read(midOp)).toThrow(SessionExpiredError);
  // The hung write finally completes after login rolled back: persistence must clear it.
  hung.resolve();
  await landed.promise;
  expect(stored).toBe('a');
  await until(() => stored === undefined);
  expect(clears).toBeGreaterThanOrEqual(1);
});

test('a failed login clears the stored session it replaced, so a restart restores nobody', async () => {
  const disk: { stored: { session: string; credentials: string } | null } = { stored: null };
  let refuseWrite = false;
  let refuseClear = false;
  const storage = {
    read: async () => disk.stored,
    async write(session: string, credentials: string) {
      if (refuseWrite) throw new Error('disk full');
      disk.stored = { session, credentials };
    },
    async clear() {
      if (refuseClear) throw new Error('disk gone');
      disk.stored = null;
    },
  };
  const signIn = () =>
    createSessionCredentials({
      scope: createSessionScope<string>(),
      refresh: async () => 'never',
      storage,
    });
  const first = signIn();
  await first.login('A', 'a');
  expect(disk.stored).toEqual({ session: 'A', credentials: 'a' });
  refuseWrite = true;
  await expect(first.login('B', 'b')).rejects.toThrow('disk full');
  expect(disk.stored).toBeNull();
  expect(await signIn().restore()).toEqual({ status: 'absent' });

  refuseWrite = false;
  await first.login('A', 'a');
  refuseWrite = true;
  refuseClear = true;
  const both = await first.login('B', 'b').catch((error: unknown) => error);
  expect(both).toBeInstanceOf(AggregateError);
  if (!(both instanceof AggregateError)) throw both;
  expect(both.errors.map((error: Error) => error.message)).toEqual(['disk full', 'disk gone']);
  expect(both.cause).toBe(both.errors[0]);
  expect(both.message).toContain('disk full');
});
