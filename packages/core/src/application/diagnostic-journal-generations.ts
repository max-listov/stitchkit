import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type DiagnosticJournalQuarantinedFile,
  type DiagnosticJournalStartupRefusal,
  quarantinedOrigin,
} from './diagnostic-journal-quarantine';

/** The path of numbered generation `index` of the journal at `path`. */
export function generation(path: string, index: number): string {
  return `${path}.${index}`;
}

function generationIndex(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return undefined;
  const value = Number(suffix);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

interface GenerationListing {
  /** Generations at or beyond `maxFiles`, which ordinary retention removes. */
  readonly expired: readonly string[];
  /** How many generations below `maxFiles` are present. */
  readonly existing: number;
  /** Names that were not regular files and were moved aside. */
  readonly quarantined: readonly DiagnosticJournalQuarantinedFile[];
  /** Quarantined files earlier opens left beside the journal, by name. */
  readonly quarantinedEarlier: readonly DiagnosticJournalQuarantinedFile[];
}

/**
 * The numbered generations and quarantined files beside the journal, from one listing before
 * startup touches anything. A generation name that is not a regular file is handed to `refuse`,
 * which throws or moves it aside; nothing is followed. Names are sorted, so what a refusal names
 * first and what the status lists does not depend on the order the filesystem returns entries in.
 */
export async function listDiagnosticJournalGenerations(
  parent: string,
  prefix: string,
  maxFiles: number,
  refuse: (
    refusal: DiagnosticJournalStartupRefusal,
  ) => Promise<DiagnosticJournalQuarantinedFile>,
): Promise<GenerationListing> {
  const expired: string[] = [];
  const quarantined: DiagnosticJournalQuarantinedFile[] = [];
  const quarantinedEarlier: DiagnosticJournalQuarantinedFile[] = [];
  let existing = 0;
  for (const name of (await readdir(parent)).sort()) {
    const origin = quarantinedOrigin(name, prefix);
    if (origin !== undefined) {
      quarantinedEarlier.push({
        file: resolve(parent, origin),
        quarantinedAs: resolve(parent, name),
      });
      continue;
    }
    const index = generationIndex(name, prefix);
    if (index === undefined) continue;
    const path = resolve(parent, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      quarantined.push(await refuse({ file: path, reason: 'not-a-regular-file' }));
    } else if (index >= maxFiles) {
      expired.push(path);
    } else {
      existing += 1;
    }
  }
  return { expired, existing, quarantined, quarantinedEarlier };
}

/** The retained generations below `maxFiles`, oldest first. */
export async function retainedDiagnosticJournalGenerations(
  parent: string,
  prefix: string,
  maxFiles: number,
): Promise<string[]> {
  const paths: { readonly index: number; readonly path: string }[] = [];
  for (const name of await readdir(parent)) {
    const index = generationIndex(name, prefix);
    if (index !== undefined && index < maxFiles) {
      paths.push({ index, path: resolve(parent, name) });
    }
  }
  return paths.sort((left, right) => right.index - left.index).map((file) => file.path);
}
