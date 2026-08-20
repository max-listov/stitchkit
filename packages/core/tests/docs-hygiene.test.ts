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
  test('every done task has done status and a completed timestamp', () => {
    const glob = new Glob('**/*.md');
    const offenders: string[] = [];
    for (const file of glob.scanSync({ cwd: DONE_DIR, absolute: true })) {
      const source = readFileSync(file, 'utf8');
      const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
      if (!frontmatter) {
        offenders.push(`${file} — missing frontmatter`);
        continue;
      }
      if (!/^status:\s*done\s*$/m.test(frontmatter)) {
        offenders.push(`${file} — status is not done`);
      }
      if (!/^completed:\s*\S.+$/m.test(frontmatter)) {
        offenders.push(`${file} — missing completed timestamp`);
      }
    }
    expect(offenders).toEqual([]);
  });

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

  test('every Регрессия attestation names a real file and a real test case (no prose claims)', () => {
    // A coverage claim in `done/` must be mechanically checkable: the required
    // form is `path/to/file.test.ts::exact test name` (several separated by
    // `;`). The named file must exist and the named case must be found in it —
    // a claim naming a test that does not exist is exactly the false
    // attestation this batch shipped eight of.
    const root = `${import.meta.dir}/../../..`;
    const glob = new Glob('**/*.md');
    const offenders: string[] = [];
    for (const file of glob.scanSync({ cwd: DONE_DIR, absolute: true })) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        // Only checkbox ATTESTATIONS are held to the form — a narrative that
        // quotes a bad claim is not itself a claim.
        const match = line.match(/^\s*- \[x\] Регрессия:\s*(.+)$/);
        if (!match?.[1]) continue;
        const at = `${file}:${index + 1}`;
        const claim = match[1].trim();
        // An explicit "no test applies" is honest and allowed — it must carry
        // its reason, not just trail off.
        if (/^не требуется — .{10,}/.test(claim)) continue;
        const references = [...claim.matchAll(/([\w./-]+\.(?:test|spec)\.\w+)::([^;]+)/g)];
        if (references.length === 0) {
          offenders.push(
            `${at} — a Регрессия claim must be "file::test name", got prose: ${claim}`,
          );
          continue;
        }
        for (const reference of references) {
          const [, path, rawName] = reference;
          if (!path || !rawName) continue;
          const testName = rawName.trim().replace(/\.$/, '');
          let source: string;
          try {
            source = readFileSync(`${root}/${path}`, 'utf8');
          } catch {
            offenders.push(`${at} — named test file does not exist: ${path}`);
            continue;
          }
          if (!source.includes(testName)) {
            offenders.push(`${at} — case "${testName}" not found in ${path}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
