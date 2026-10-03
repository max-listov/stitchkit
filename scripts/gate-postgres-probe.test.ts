import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { postgresFingerprint } from './gate-lane-environment';

function packet(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

/** Minimal local protocol peer exercises the actual Bun SQL transport without psql. */
function postgresPeer(hang = false) {
  const connections = new Set<Bun.Socket<{ buffer: Buffer; startup: boolean }>>();
  let queries = 0;
  const description = Buffer.alloc(18);
  description.writeInt32BE(25, 6);
  description.writeInt16BE(-1, 10);
  description.writeInt32BE(-1, 12);
  const rowDescription = packet(
    'T',
    Buffer.concat([Buffer.from([0, 1]), Buffer.from('proof\0'), description]),
  );
  function proofRow(port: number): Buffer {
    const proof = JSON.stringify({
      version: '18.0',
      database: 'fixture',
      user: 'fixture',
      address: '127.0.0.1',
      port,
    });
    const length = Buffer.alloc(4);
    length.writeInt32BE(Buffer.byteLength(proof));
    return packet('D', Buffer.concat([Buffer.from([0, 1]), length, Buffer.from(proof)]));
  }
  const ready = packet('Z', Buffer.from('I'));
  const server = Bun.listen<{ buffer: Buffer; startup: boolean }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0), startup: true };
        connections.add(socket);
      },
      close(socket) {
        connections.delete(socket);
      },
      data(socket, bytes) {
        socket.data.buffer = Buffer.concat([socket.data.buffer, bytes]);
        while (socket.data.buffer.length >= (socket.data.startup ? 4 : 5)) {
          const source = socket.data.buffer;
          const size = source.readInt32BE(socket.data.startup ? 0 : 1);
          const total = size + (socket.data.startup ? 0 : 1);
          if (source.length < total) return;
          socket.data.buffer = source.subarray(total);
          if (socket.data.startup) {
            if (source.readInt32BE(4) === 80877103) {
              socket.write('N');
              continue;
            }
            socket.data.startup = false;
            socket.write(
              Buffer.concat([
                packet('R', Buffer.alloc(4)),
                packet('S', Buffer.from('server_version\0' + '18.0\0')),
                ready,
              ]),
            );
            continue;
          }
          const type = source.toString('ascii', 0, 1);
          if (type === 'X') {
            socket.end();
            return;
          }
          if (hang) continue;
          if (type === 'P') socket.write(packet('1'));
          if (type === 'B') socket.write(packet('2'));
          if (type === 'D') {
            if (source[5] === 83) socket.write(packet('t', Buffer.from([0, 0])));
            socket.write(rowDescription);
          }
          if (type === 'E' || type === 'Q') {
            queries += 1;
            if (type === 'Q') socket.write(rowDescription);
            socket.write(
              Buffer.concat([proofRow(server.port), packet('C', Buffer.from('SELECT 1\0'))]),
            );
          }
          if (type === 'S' || type === 'Q') socket.write(ready);
        }
      },
    },
  });
  return {
    port: server.port,
    connections,
    queries: () => queries,
    close() {
      for (const socket of connections) socket.terminate();
      server.stop(true);
    },
  };
}

test('URL fingerprint uses the actual Bun SQL lane transport with no psql executable', async () => {
  const peer = postgresPeer();
  try {
    const connection = new URL(`postgresql://fixture@127.0.0.1:${peer.port}/fixture`);
    connection.password = 'secret';
    const url = connection.href;
    const first = await postgresFingerprint({
      PATH: '',
      STARTER_TEST_DATABASE_ADMIN_URL: url,
    });
    expect(first).toContain('pg:18.0:');
    expect(first).not.toContain('secret');
    expect(first).not.toContain('fixture');
    connection.password = 'rotated';
    const rotated = await postgresFingerprint({
      PATH: '',
      STARTER_TEST_DATABASE_ADMIN_URL: connection.href,
    });
    expect(rotated).toBe(first);
    const certificatePassword = await postgresFingerprint({
      PATH: '',
      STARTER_TEST_DATABASE_ADMIN_URL: `${url}?sslpassword=certificate-secret`,
    });
    const certificateRotation = await postgresFingerprint({
      PATH: '',
      STARTER_TEST_DATABASE_ADMIN_URL: `${url}?sslpassword=certificate-rotated`,
    });
    expect(certificateRotation).toBe(certificatePassword);
    expect(
      await postgresFingerprint({
        PATH: '',
        PGHOST: 'ineffective-override',
        STARTER_TEST_DATABASE_ADMIN_URL: url,
      }),
    ).toBe(first);
    expect(peer.queries()).toBe(5);
  } finally {
    peer.close();
  }
});

test('an unresponsive SQL peer cannot leave a reusable proof or a live connection', async () => {
  const peer = postgresPeer(true);
  try {
    const started = performance.now();
    const result = await postgresFingerprint(
      {
        PATH: '',
        STARTER_TEST_DATABASE_ADMIN_URL: `postgresql://fixture@127.0.0.1:${peer.port}/fixture`,
      },
      100,
    );
    expect(result).toContain('pg:unmeasurable:');
    expect(performance.now() - started).toBeLessThan(900);
    for (let index = 0; peer.connections.size > 0 && index < 20; index += 1)
      await Bun.sleep(5);
    expect(peer.connections.size).toBe(0);
  } finally {
    peer.close();
  }
});
