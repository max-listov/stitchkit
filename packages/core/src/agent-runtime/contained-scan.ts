import path from 'node:path';
import { openDirectoryAt, openPinnedDirectory } from '../internal/contained-directory';
import {
  type ContainedEntryKind,
  type ContainedFile,
  listAt,
  openFileAt,
} from '../internal/contained-files';
import type { ContainedFileHandle } from '../internal/contained-handle';
import { readContainedUtf8Handle } from '../internal/contained-read';
import { errnoOf } from '../internal/errno';
import { ContainedScanBudget, ScanStopped } from './contained-scan-budget';

interface ScanInput {
  /** A supplied capability remains owned by the caller, which has already charged its open. */
  root: string | ContainedFileHandle;
  maxDepth: number;
  maxFiles: number;
  symlinks: 'refuse' | 'skip';
  readMaxBytes?: number;
  skipUnreadable?: boolean;
  excludeDirectory?: (relative: string) => boolean;
  includeFile?: (relative: string) => boolean;
  authorizePath?: (relative: string, kind: ContainedEntryKind) => boolean | Promise<boolean>;
  budget?: ContainedScanBudget;
  /** Returning false stops traversal; the visitor owns its precise stop reason. */
  visitFile?: (file: ContainedFile) => boolean | Promise<boolean>;
  maxDiagnostics?: number;
  basePath?: string;
  /** A direct discovery consumer may handle a disclosed entry and prune it. */
  visitEntry?: (
    directory: ContainedFileHandle,
    entry: { name: string; kind: ContainedEntryKind },
    relative: string,
  ) => boolean | Promise<boolean>;
}

export async function walkContainedFiles(input: {
  root: string;
  maxDepth: number;
  maxFiles: number;
  readMaxBytes?: number;
}): Promise<readonly ContainedFile[]> {
  const scan = await scanContainedFiles({ ...input, symlinks: 'refuse' });
  if (scan.truncated) throw new Error('Contained file traversal exceeded its bounds');
  return scan.files;
}

/** One descriptor-anchored walker; search consumes each file before opening the next. */
export async function scanContainedFiles(
  input: ScanInput,
  io = { openRoot: openPinnedDirectory, list: listAt },
) {
  const budget = input.budget ?? new ContainedScanBudget();
  const files: ContainedFile[] = [];
  const denied: { relative: string; kind: ContainedEntryKind }[] = [];
  const errors: { path: string; operation: string; code: string }[] = [];
  let deniedTruncated = false;
  let errorsTruncated = false;
  let skippedDirectories = 0;
  let skippedSymlinks = 0;
  let scannedFiles = 0;
  let stopped = false;
  const disposeLate = (handle: ContainedFileHandle) => {
    void handle.close().catch(() => undefined);
  };
  const report = (error: unknown, relative: string, operation: string): void => {
    if (error instanceof ScanStopped || !input.skipUnreadable) throw error;
    budget.reasons.add('unreadable');
    if (errors.length < (input.maxDiagnostics ?? input.maxFiles)) {
      const code = errnoOf(error);
      errors.push({
        path: relative,
        operation,
        code: code && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : 'READ_FAILED',
      });
    } else errorsTruncated = true;
  };
  const readFile = async (directory: ContainedFileHandle, name: string) => {
    const maximum = input.readMaxBytes;
    if (maximum === undefined) return undefined;
    const allowance = budget.readAllowance(maximum);
    const handle = await budget.wait(() => openFileAt(directory, name), disposeLate);
    try {
      return await readContainedUtf8Handle(handle, allowance, {
        check: () => budget.check(),
        readBytes: (bytes) => {
          budget.readBytes += bytes;
        },
        wait: (operation) => budget.wait(operation),
      });
    } catch (error) {
      if (errnoOf(error) === 'FILE_TOO_LARGE') {
        if (allowance < maximum) budget.stop('max-bytes');
        budget.reasons.add('max-file-bytes');
      }
      throw error;
    } finally {
      await handle.close();
    }
  };
  const visitEntry = async (
    directory: ContainedFileHandle,
    entry: Awaited<ReturnType<typeof listAt>>[number],
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    budget.check();
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const kind = entry.isDirectory()
      ? 'directory'
      : entry.isSymbolicLink()
        ? 'symlink'
        : entry.isFile()
          ? 'file'
          : 'other';
    if (kind === 'file' && input.includeFile && !input.includeFile(relative)) return;
    if (kind === 'directory' && input.excludeDirectory?.(relative)) {
      skippedDirectories += 1;
      return;
    }
    if (
      input.authorizePath &&
      !(await budget.wait(async () => input.authorizePath?.(relative, kind)))
    ) {
      budget.reasons.add('denied');
      if (denied.length < (input.maxDiagnostics ?? input.maxFiles))
        denied.push({ relative, kind });
      else deniedTruncated = true;
      return;
    }
    budget.check();
    if (
      input.visitEntry &&
      !(await input.visitEntry(directory, { name: entry.name, kind }, relative))
    )
      return;
    if (kind === 'symlink') {
      if (input.symlinks === 'refuse')
        throw new Error(`Contained file traversal refuses symlink: ${relative}`);
      skippedSymlinks += 1;
      return;
    }
    if (kind === 'directory') {
      if (depth >= input.maxDepth) {
        budget.reasons.add('max-depth');
        return;
      }
      budget.directory();
      let child: ContainedFileHandle;
      try {
        child = await budget.wait(() => openDirectoryAt(directory, entry.name), disposeLate);
      } catch (error) {
        report(error, relative, 'open-directory');
        return;
      }
      try {
        await visit(child, relative, depth + 1);
      } finally {
        await child.close();
      }
    } else if (kind === 'file') {
      if (scannedFiles >= input.maxFiles) budget.stop('max-files');
      let content: ContainedFile['content'];
      try {
        content = await readFile(directory, entry.name);
      } catch (error) {
        report(error, relative, 'read-file');
        return;
      }
      budget.check();
      scannedFiles += 1;
      const file = { absolute: relative, relative, ...(content && { content }) };
      if (input.visitFile) stopped = !(await input.visitFile(file));
      else files.push(file);
    }
  };
  const visit = async (directory: ContainedFileHandle, relative: string, depth: number) => {
    budget.check();
    const remaining = budget.remainingEntries();
    let countedEntries = 0;
    let entries: Awaited<ReturnType<typeof listAt>>;
    try {
      entries = await budget.wait(() =>
        io.list(directory, remaining, {
          check: () => budget.check(),
          entry: () => {
            budget.visitedEntries += 1;
            countedEntries += 1;
          },
        }),
      );
    } catch (error) {
      report(error, relative || '.', 'read-directory');
      return;
    }
    if (countedEntries === 0) budget.visitedEntries += entries.length;
    // No lookahead is read outside the entry budget. Equality conservatively means partial.
    if (
      budget.limits.maxEntries !== undefined &&
      budget.visitedEntries >= budget.limits.maxEntries
    )
      budget.reasons.add('max-entries');
    for (const entry of [...entries].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (stopped) break;
      await visitEntry(directory, entry, relative, depth);
    }
  };
  try {
    let root: ContainedFileHandle;
    if (typeof input.root === 'string') {
      budget.directory();
      const rootPath = input.root;
      try {
        root = await budget.wait(() => io.openRoot(rootPath), disposeLate);
      } catch (error) {
        report(error, '.', 'open-directory');
        return result();
      }
    } else root = input.root;
    try {
      await visit(root, input.basePath === '.' ? '' : (input.basePath ?? ''), 0);
    } finally {
      if (typeof input.root === 'string') await root.close();
    }
  } catch (error) {
    if (!(error instanceof ScanStopped)) throw error;
  }
  function result() {
    return {
      files,
      truncated: budget.reasons.size > 0 || stopped,
      scannedFiles,
      skippedDirectories,
      skippedSymlinks,
      denied,
      deniedTruncated,
      errors,
      errorsTruncated,
    };
  }
  return result();
}
