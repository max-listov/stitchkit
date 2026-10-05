/**
 * What a public document may not carry.
 *
 * This repository is public and its documents are English: a reader of the
 * package, of `llms-full.txt` or of the GitHub tree must not meet another
 * language or the bookkeeping of whoever wrote the page. Two classes are
 * refused in the documents below, and both are mechanical so that a review never
 * has to remember them:
 *
 * - Cyrillic text, except a literal that is itself an example of non-English
 *   input (`CYRILLIC_EXAMPLE_LITERALS`). Each literal is granted for the files
 *   that hold it and says why it is not prose.
 * - Agent metadata in front matter: `participants`, `harness` and `model` keys
 *   belong to the private task records, never to a published page.
 */

/** The rule names, as findings report them. */
export const CYRILLIC_RULE = 'Cyrillic text in a public document';
export const AGENT_METADATA_RULE = 'agent metadata in a public document';

/** Documents readers see: the docs tree, the root pages, the core package's pages and generated llms files. */
const PUBLIC_DOCUMENT =
  /^(?:docs\/.+|(?:README|CHANGELOG|CONTRIBUTING|AGENTS)\.md|packages\/core\/(?:[^/]+\.md|llms[^/]*\.txt|llms\/.+))$/;

export function isPublicDocumentPath(file: string): boolean {
  return PUBLIC_DOCUMENT.test(file);
}

export interface CyrillicExample {
  /** The exact text that may stay, as written in the document. */
  literal: string;
  /** Files that hold it; generated llms files repeat the page they were built from. */
  files: readonly string[];
  because: string;
}

const SENTENCE_CUTTER_FILES = [
  'docs/guide/voice.md',
  'docs/api/reference.md',
  'CHANGELOG.md',
  'packages/core/CHANGELOG.md',
  'packages/core/llms-full.txt',
  'packages/core/llms/voice.txt',
];

/**
 * Cyrillic that is a literal example in code or prose about non-English input.
 * Longest literal first: a shorter one would leave the rest of the line behind.
 */
export const CYRILLIC_EXAMPLE_LITERALS: readonly CyrillicExample[] = [
  {
    literal: 'т. е. так',
    files: SENTENCE_CUTTER_FILES,
    because:
      'A sample sentence showing that the Russian abbreviation `т. е.` ("i.e.") does not end a sentence for the speech sentence cutter.',
  },
  {
    literal: 'т. е.',
    files: SENTENCE_CUTTER_FILES,
    because:
      'The Russian abbreviation the sentence cutter must not split at, named next to `3.5` as the cases it skips.',
  },
  {
    literal: 'поиск',
    files: ['docs/decisions/0035-tool-name-derivation-and-validation.md'],
    because:
      'A real non-ASCII command name ("search") the decision uses to show what a stricter charset would have refused.',
  },
];

const CYRILLIC = /[Ѐ-ӿ]/;
const AGENT_KEY = /^\s*(?:participants|harness|model):/;
const TOP_LEVEL_PARTICIPANTS = /^participants:/;

export interface PublicDocumentFinding {
  line: number;
  rule: string;
}

/** Index of the line that closes a front matter block opened on line 0, or -1 when there is none. */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trimEnd() !== '---') return -1;
  return lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---');
}

function withoutExamples(file: string, line: string): string {
  let rest = line;
  for (const example of CYRILLIC_EXAMPLE_LITERALS) {
    if (example.files.includes(file)) rest = rest.replaceAll(example.literal, '');
  }
  return rest;
}

/** Findings for one document; a path that is not a public document has none. */
export function inspectPublicDocument(
  file: string,
  contents: string,
): PublicDocumentFinding[] {
  if (!isPublicDocumentPath(file)) return [];
  const lines = contents.split('\n');
  const frontMatter = frontMatterEnd(lines);
  const findings: PublicDocumentFinding[] = [];
  for (const [index, line] of lines.entries()) {
    const inFrontMatter = frontMatter > 0 && index < frontMatter;
    if (CYRILLIC.test(withoutExamples(file, line))) {
      findings.push({ line: index + 1, rule: CYRILLIC_RULE });
    }
    if (inFrontMatter ? AGENT_KEY.test(line) : TOP_LEVEL_PARTICIPANTS.test(line)) {
      findings.push({ line: index + 1, rule: AGENT_METADATA_RULE });
    }
  }
  return findings;
}
