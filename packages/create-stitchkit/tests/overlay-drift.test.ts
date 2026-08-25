import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * An overlay file is a near-copy, and a near-copy silently stops tracking.
 *
 * `examples/repository/.../starter-page.tsx` differs from the template's page
 * by one import and one three-line block — 146 of 151 lines are the same file.
 * Nothing compared them, so every future edit to the template's landing page
 * simply stopped applying to `--example repository`, with no signal at all.
 *
 * This does not forbid the divergence — the whole point of an overlay is to
 * diverge. It pins HOW MUCH: the moment the shared body moves, this fails and
 * whoever moved it decides whether the example follows.
 */
const root = join(import.meta.dir, '..');

/** Lines the overlay is allowed to differ by, and nothing more. */
const ALLOWED_DIVERGENCE: Record<string, { added: string[]; removed: string[] }> = {
  'packages/frontend/src/app/[locale]/starter-page.tsx': {
    // Compared as line SETS, so `</div>` and `</p>` — which both files already
    // contain elsewhere — do not show up as divergence.
    added: [
      "import { RepositorySummary } from '@/components/repository-summary';",
      "<div className='mt-5 w-full'>",
      '<RepositorySummary />',
    ],
    removed: [
      "<p className='mt-5 text-sm text-muted-foreground'>",
      'Add your first vertical feature from schema to transport and UI.',
    ],
  },
};

for (const [relative, allowed] of Object.entries(ALLOWED_DIVERGENCE)) {
  test(`the repository overlay of ${relative} differs only where it means to`, async () => {
    const template = (await readFile(join(root, 'template', relative), 'utf8')).split('\n');
    const overlay = (
      await readFile(join(root, 'examples/repository', relative), 'utf8')
    ).split('\n');

    const templateLines = new Set(template.map((line) => line.trim()));
    const overlayLines = new Set(overlay.map((line) => line.trim()));

    const added = [...overlayLines].filter((line) => line && !templateLines.has(line));
    const removed = [...templateLines].filter((line) => line && !overlayLines.has(line));

    expect(added.sort()).toEqual([...allowed.added].sort());
    expect(removed.sort()).toEqual([...allowed.removed].sort());
  });
}
