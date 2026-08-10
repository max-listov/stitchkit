import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exampleRealtimeContract, publishExampleNote } from '../examples/realtime-room';
import { createValidatedRealtimeSocket, REALTIME_TARGET_FORMS } from '../src/realtime/socket';

function adapter(target: object) {
  return createValidatedRealtimeSocket({
    target,
    inbound: exampleRealtimeContract.serverToClient,
    outbound: exampleRealtimeContract.serverToClient,
    inboundDirection: 'server-inbound',
    outboundDirection: 'server-outbound',
  });
}

function supports(capabilities: readonly string[], capability: string): boolean {
  return capabilities.includes(capability);
}

describe('realtime adapter readiness matrix', () => {
  for (const form of REALTIME_TARGET_FORMS) {
    test(`${form.name} exposes its declared capability set`, () => {
      const calls: string[] = [];
      const target: Record<string, (...args: unknown[]) => void> = {};
      for (const capability of form.capabilities) {
        target[capability] = (...args) => {
          calls.push(`${capability}:${String(args[0])}`);
        };
      }

      const realtime = adapter(target);
      realtime.emit('note:created', { id: 'note-1', text: 'Ready' });
      expect(calls).toContain('emit:note:created');

      if (supports(form.capabilities, 'on')) {
        expect(() => realtime.on('note:created', () => undefined)).not.toThrow();
      } else {
        expect(() => realtime.on('note:created', () => undefined)).toThrow(
          'Realtime target does not implement on()',
        );
      }
    });
  }
});

test('the canonical room example executes and matches the guide byte-for-byte', async () => {
  const calls: Array<{ room: string; event: string; value: unknown }> = [];
  const realtime = {
    onConnection: () => () => undefined,
    emit: () => undefined,
    to: (room: string) => ({
      emit: (event: 'note:created', value: { id: string; text: string }) =>
        calls.push({ room, event, value }),
    }),
  };
  publishExampleNote(realtime);
  expect(calls).toEqual([
    {
      room: 'general',
      event: 'note:created',
      value: { id: 'note-1', text: 'Ready' },
    },
  ]);

  const root = join(import.meta.dir, '../../..');
  const source = await readFile(join(root, 'packages/core/examples/realtime-room.ts'), 'utf8');
  const guide = await readFile(join(root, 'docs/guide/realtime.md'), 'utf8');
  const sourceBody = source.match(
    /\/\/ canonical-example:start\n([\s\S]*?)\/\/ canonical-example:end/,
  )?.[1];
  const guideBody = guide.match(/```ts canonical-realtime-room\n([\s\S]*?)```/)?.[1];
  expect(sourceBody).toBeDefined();
  expect(guideBody).toBe(sourceBody);
});
