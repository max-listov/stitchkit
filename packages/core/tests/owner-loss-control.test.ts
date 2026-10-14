import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { attachOwnerLossControl, awaitCommandStart } from '../src/process/owner-loss-control';

test('guard exit cannot overtake a started message buffered in its control socket', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const control = new PassThrough();
  attachOwnerLossControl(child, control);
  const started = awaitCommandStart(child);
  child.emit('exit', 0, null);
  control.end('{"kind":"started","pid":456}\n');
  expect(await started).toBe(123);
});

test('a closed guard control channel without a started message refuses the launch', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const control = new PassThrough();
  attachOwnerLossControl(child, control);
  const started = awaitCommandStart(child);
  child.emit('exit', 1, null);
  control.end();
  await expect(started).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
});
