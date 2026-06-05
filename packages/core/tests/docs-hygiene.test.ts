/**
 * Backlog hygiene guard. `docs/backlog/done/` is the archive of **finished**
 * work — an unchecked `- [ ]` there means the task wasn't actually done, so it
 * does not belong in `done/`. When a task moves to `done/`, every checkbox is
 * resolved: `[x]` for completed, or `[x]` with a "→ spun out / rejected" note.
 * This catches a re-introduction (it slipped through manual review once).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

const DONE_DIR = `${import.meta.dir}/../../../docs/backlog/done`;

describe('backlog hygiene', () => {
  test('no unchecked checkboxes in docs/backlog/done (done = finished)', () => {
    const glob = new Glob('**/*.md');
    const offenders: string[] = [];
    for (const file of glob.scanSync({ cwd: DONE_DIR, absolute: true })) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*- \[ \]/.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
