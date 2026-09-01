import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Every repository path a guide names has to exist.
 *
 * `ADDING_A_FEATURE.md` is the one document a new consumer executes literally, and two of its
 * steps pointed at files the scaffold does not contain — `lib/api/client.ts` and a "shared
 * realtime source". The reader does not learn that by reading; they learn it by opening the path
 * and finding nothing, after having already trusted the sentence around it.
 *
 * A path the guide tells you to CREATE is not a broken reference, so those are declared by the
 * guide itself: a line that introduces one carries `(created in this step)`. Everything else
 * must resolve.
 */
const GUIDES = ['docs/ADDING_A_FEATURE.md'];
const PATH_PATTERN = /`((?:packages|scripts|docs|e2e)\/[A-Za-z0-9_./-]+)`/g;

export interface GuidePathFinding {
  readonly guide: string;
  readonly line: number;
  readonly path: string;
}

export function inspectGuide(
  guide: string,
  source: string,
  exists: (path: string) => boolean,
): GuidePathFinding[] {
  const findings: GuidePathFinding[] = [];
  source.split('\n').forEach((text, index) => {
    if (text.includes('(created in this step)')) return;
    for (const match of text.matchAll(PATH_PATTERN)) {
      const path = match[1];
      if (!path || exists(path)) continue;
      findings.push({ guide, line: index + 1, path });
    }
  });
  return findings;
}

export async function inspectGuides(root: string): Promise<GuidePathFinding[]> {
  const findings: GuidePathFinding[] = [];
  for (const guide of GUIDES) {
    const absolute = resolve(root, guide);
    if (!existsSync(absolute)) {
      findings.push({ guide, line: 0, path: guide });
      continue;
    }
    findings.push(
      ...inspectGuide(guide, await readFile(absolute, 'utf8'), (path) =>
        existsSync(join(root, path)),
      ),
    );
  }
  return findings;
}

if (import.meta.main) {
  const findings = await inspectGuides(resolve(import.meta.dir, '..'));
  for (const { guide, line, path } of findings) {
    console.error(`${guide}:${line}: names ${path}, which does not exist`);
  }
  if (findings.length > 0) process.exit(1);
}
