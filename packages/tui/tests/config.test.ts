import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileAgentModelSelectionStore } from '../src/config';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('file Agent TUI model selections', () => {
  test('keeps concurrent hosts and conversations in independent atomic records', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-tui-models-'));
    roots.push(root);
    const first = createFileAgentModelSelectionStore(root);
    const second = createFileAgentModelSelectionStore(root);
    const at = '2026-08-30T00:00:00.000Z';
    await Promise.all([
      first.save('conversation/a', { modelId: 'model-a', selectedAt: at }),
      second.save('conversation/b', { modelId: 'model-b', selectedAt: at }),
    ]);
    expect(await second.load('conversation/a')).toEqual({
      modelId: 'model-a',
      selectedAt: at,
    });
    expect(await first.load('conversation/b')).toEqual({
      modelId: 'model-b',
      selectedAt: at,
    });
  });
});
