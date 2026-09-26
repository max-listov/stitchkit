import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { readPipedStdin } from '../src/tools/cli/stdin';

function expectReleased(input: PassThrough) {
  for (const event of ['data', 'end', 'error', 'close'])
    expect(input.listenerCount(event)).toBe(0);
  expect(input.isPaused()).toBe(true);
  expect(input.destroyed).toBe(false);
}

test('empty open stream releases listeners and remains usable after the probe', async () => {
  const input = new PassThrough();
  expect(await readPipedStdin(input)).toBeNull();
  expectReleased(input);
  const later = readPipedStdin(input);
  input.end('later');
  expect(await later).toBe('later');
});

test('read errors propagate instead of returning partial input', async () => {
  const input = new PassThrough();
  const result = readPipedStdin(input);
  input.write('partial');
  input.emit('error', new Error('read failed'));
  await expect(result).rejects.toThrow('read failed');
  expectReleased(input);
  input.destroy();
});

test('premature close rejects rather than accepting partial data', async () => {
  const input = new PassThrough();
  const result = readPipedStdin(input);
  input.write('partial');
  input.destroy();
  await expect(result).rejects.toThrow('stdin closed before EOF');
});

test('whitespace-only data keeps the existing empty-input semantics', async () => {
  const input = new PassThrough();
  const result = readPipedStdin(input);
  input.end(' \n\t ');
  expect(await result).toBeNull();
});
