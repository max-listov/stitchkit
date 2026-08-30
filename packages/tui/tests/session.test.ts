import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentTuiClient,
  listAgentTuiSessions,
  startAgentTuiSessionHost,
} from '../src/session';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('local Agent TUI session host', () => {
  test('routes authenticated external submissions through the live host', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'stitchkit-tui-'));
    temporaryDirectories.push(rootDirectory);
    let liveSessionId = '';
    const host = await startAgentTuiSessionHost({
      rootDirectory,
      conversationId: 'main',
      handle: async (request) => ({
        requestId: request.requestId,
        outcome: 'ok',
        sessionId: liveSessionId,
        conversationId: 'main',
        ...(request.operation === 'submit' && { runId: 'run-1' }),
      }),
    });
    liveSessionId = host.sessionId;
    const [descriptor] = await listAgentTuiSessions(rootDirectory);
    if (!descriptor) throw new Error('session descriptor was not written');
    expect(descriptor?.sessionId).toBe(host.sessionId);
    expect((await stat(descriptor?.socketPath ?? '')).mode & 0o777).toBe(0o600);
    const client = await createAgentTuiClient({ rootDirectory, sessionId: host.sessionId });
    expect(
      await client.request({
        requestId: 'request-1',
        operation: 'submit',
        text: 'hello',
        idempotencyKey: 'dedupe-1',
      }),
    ).toMatchObject({ outcome: 'ok', runId: 'run-1' });
    const [first, second] = await Promise.all([
      client.request({ requestId: 'status-1', operation: 'status' }),
      client.request({ requestId: 'status-2', operation: 'status' }),
    ]);
    expect(first.outcome).toBe('ok');
    expect(second.outcome).toBe('ok');
    await host.setConversationId('conversation-fresh');
    expect((await listAgentTuiSessions(rootDirectory))[0]?.conversationId).toBe(
      'conversation-fresh',
    );
    const unauthorized = await fetch('http://localhost/request', {
      method: 'POST',
      unix: descriptor.socketPath,
      body: JSON.stringify({ requestId: 'bad', operation: 'status' }),
    });
    expect(unauthorized.status).toBe(401);
    const malformed = await fetch('http://localhost/request', {
      method: 'POST',
      unix: descriptor.socketPath,
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch('http://localhost/request', {
      method: 'POST',
      unix: descriptor.socketPath,
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
      },
      body: 'x'.repeat(70_000),
    });
    expect(oversized.status).toBe(413);
    await host.close();
    expect(await listAgentTuiSessions(rootDirectory)).toEqual([]);
  });

  test('removes a dead descriptor without following its declared socket path', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'stitchkit-tui-'));
    temporaryDirectories.push(rootDirectory);
    const directory = path.join(rootDirectory, '.stitchkit', 'tui', 'sessions');
    await mkdir(directory, { recursive: true });
    const protectedFile = path.join(rootDirectory, 'keep');
    await writeFile(protectedFile, 'present');
    await writeFile(
      path.join(directory, 'deadbeef.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'deadbeef',
        conversationId: 'main',
        socketPath: protectedFile,
        token: 'x'.repeat(32),
        pid: 2_147_483_647,
        startedAt: '2026-08-30T00:00:00.000Z',
      }),
    );
    expect(await listAgentTuiSessions(rootDirectory)).toEqual([]);
    expect(await Bun.file(protectedFile).text()).toBe('present');
  });

  test('does not publish a stale descriptor merely because its pid was reused', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'stitchkit-tui-'));
    temporaryDirectories.push(rootDirectory);
    const directory = path.join(rootDirectory, '.stitchkit', 'tui', 'sessions');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'reusedpid.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'reusedpid',
        conversationId: 'main',
        socketPath: path.join(directory, 'reusedpid.sock'),
        token: 'x'.repeat(32),
        pid: process.pid,
        startedAt: '2026-08-30T00:00:00.000Z',
      }),
    );
    expect(await listAgentTuiSessions(rootDirectory)).toEqual([]);
    expect(await Bun.file(path.join(directory, 'reusedpid.json')).exists()).toBe(false);
  });
});
