/**
 * The publication-privacy scan, run on every push and never memoised.
 *
 * The scan itself is not new — `publication-privacy.test.ts` has asserted the
 * same thing for a long time. What is new is *when* it runs, and that is the
 * whole defect it repairs.
 *
 * `verify` remembers a green run by the working-tree hash, and that hash is
 * taken with `git add --all .` into a scratch index — so it counts untracked
 * files. The scan reads the **real** index, so it does not see them. Those two
 * notions of "the tree" agree everywhere except one transition, which is the
 * most ordinary thing a person does:
 *
 *   1. write a new file        → hash H (the file is in it), scan cannot see it
 *   2. run the gate            → green, remembered under H
 *   3. `git add`               → contents unchanged, so the hash is still H
 *   4. push                    → memo hits, the whole suite is skipped
 *
 * The file reaches history without the local gate ever looking at it. Measured,
 * not argued: on a clone the same tree hash yields 30 findings before `git add`
 * and 31 after.
 *
 * That is how a real machine path reached a public repository in
 * `check-declarations-strict.mjs`. The scan was not blind — it was late. CI ran
 * it and went red, naming the file and line exactly. But a push to a public
 * repository publishes at the moment of the push, and CI answers afterwards, so
 * the only check that could have refused the content while refusing still meant
 * anything was the local one, and the memo had skipped it. The leak was public
 * for a day and scrubbed by hand in the next release.
 *
 * Folding the index into the memo key would fix it and cost far more than it
 * saves: `git add` would invalidate a release run and re-spend thirteen minutes
 * of heavy lanes to satisfy a check that takes a third of a second. So this
 * check leaves the memo instead, and joins the pre-push metadata gate — the
 * place this repository already reserves for cheap things that must be true
 * every time. Metadata before machinery, for the same reason.
 */
import {
  inspectTrackedPublication,
  STITCHKIT_CONVENTIONS,
  STITCHKIT_EXEMPTIONS,
} from './publication-privacy';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const findings = await inspectTrackedPublication({
  root,
  conventions: STITCHKIT_CONVENTIONS,
  exemptions: STITCHKIT_EXEMPTIONS,
});

if (findings.length > 0) {
  process.stderr.write(
    `[gate] publication privacy: ${findings.length} unexplained finding(s) in what git carries\n`,
  );
  for (const finding of findings) {
    process.stderr.write(`  ${finding.file}:${finding.line} ${finding.rule}\n`);
  }
  process.stderr.write(
    '  Remove it, or add an allowance to STITCHKIT_EXEMPTIONS in scripts/publication-privacy.ts saying why it is not a leak.\n',
  );
  process.exit(1);
}

process.stderr.write('[gate] publication privacy: what git carries is clean\n');
