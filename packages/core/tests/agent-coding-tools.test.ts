import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { ShellOutputSchema } from '../src/agent-runtime/coding-tool-contract';
import {
  type AgentCodingToolAuthorization,
  createAgentCodingTools,
} from '../src/agent-runtime-coding-tools';
import { mountAgent } from '../src/tools';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`descendant process ${pid} remained alive`);
}

describe('host-authorized Agent coding tools', () => {
  test('search bounds denied entries independently of include filtering', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-search-denied-'));
    roots.push(root);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeFile(path.join(root, `file-${i}.txt`), 'match'),
      ),
    );
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        authorizePath: ({ path: relative }) => relative === '.',
        limits: { maxSearchResults: 2 },
      }),
    });
    const result = await executable(tools, 'search_files')(
      { query: 'match' },
      { toolCallId: 'denied', messages: [], context: undefined },
    );
    expect(result.denied).toHaveLength(2);
    expect(result.deniedTruncated).toBe(true);
    const filtered = await executable(tools, 'search_files')(
      { query: 'match', include: '*.ts' },
      { toolCallId: 'filtered', messages: [], context: undefined },
    );
    expect(filtered.denied ?? []).toHaveLength(0);
  });
  test('EOF respects ASCII byte caps, non-UTF8 is named and replacement is literal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-contracts-'));
    roots.push(root);
    await writeFile(path.join(root, 'ascii.txt'), 'abcde');
    await writeFile(path.join(root, 'invalid.txt'), Buffer.from([255, 255]));
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });
    const options = { toolCallId: 'contracts', messages: [], context: undefined };
    const read = await executable(tools, 'read_file')(
      { path: 'ascii.txt', maxBytes: 1 },
      options,
    );
    expect(read).toMatchObject({ text: 'a', bytes: 1, nextOffset: 1, truncated: true });
    await expect(
      executable(tools, 'read_file')({ path: 'invalid.txt' }, options),
    ).rejects.toMatchObject({
      output: { error: 'BAD_REQUEST', details: { reason: 'invalid_utf8' } },
    });
    await executable(tools, 'edit_file')(
      {
        path: 'ascii.txt',
        oldText: 'abcde',
        newText: 'cost=$$PRICE and $& marker',
        expectedSha256: read.sha256,
      },
      options,
    );
    expect(await readFile(path.join(root, 'ascii.txt'), 'utf8')).toBe(
      'cost=$$PRICE and $& marker',
    );
  });

  test('publishes anchored include semantics and explains zero post-filter coverage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-include-'));
    roots.push(root);
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(
      path.join(root, 'src', 'nested', 'match.ts'),
      'export const needle = true;\n',
    );
    const definitions = createAgentCodingTools({ root, authorize: () => true });
    const definition = definitions.find(({ name }) => name === 'search_files');
    if (!definition?.output) throw new Error('search_files definition is missing');
    const inputSchema = JSON.stringify(z.toJSONSchema(definition.input));
    const outputSchema = JSON.stringify(z.toJSONSchema(definition.output));
    expect(inputSchema).toContain('Anchored');
    expect(inputSchema).toContain('whole workspace-relative path');
    expect(inputSchema).toContain('`*` does not cross `/`');
    expect(inputSchema).toContain('`**/`');
    expect(outputSchema).toContain('admitted by include and host authorization');

    const tools = mountAgent([], { runtimeTools: definitions });
    const options = { toolCallId: 'include-coverage', messages: [], context: undefined };
    for (const mode of ['content', 'path']) {
      const query = mode === 'content' ? 'needle' : 'match.ts';
      expect(
        await executable(tools, 'search_files')({ query, mode, include: '*.ts' }, options),
      ).toMatchObject({
        matches: [],
        scannedFiles: 0,
        hint: expect.stringContaining('rejected all 1 file'),
      });
      expect(
        await executable(tools, 'search_files')({ query, mode, include: '**/*.ts' }, options),
      ).toMatchObject({
        matches: [expect.objectContaining({ path: path.join('src', 'nested', 'match.ts') })],
        scannedFiles: 1,
      });
      expect(await executable(tools, 'search_files')({ query, mode }, options)).toMatchObject({
        matches: [expect.objectContaining({ path: path.join('src', 'nested', 'match.ts') })],
        scannedFiles: 1,
      });
    }
  });

  test('an empty workspace does not blame the include pattern for its zero', async () => {
    // The hint judges the filter, so it may only appear where the filter is
    // what produced the zero. A workspace with nothing to reject returns the
    // same empty result and no accusation — otherwise the reader rewrites a
    // glob that was never at fault.
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-empty-'));
    roots.push(root);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });
    const options = { toolCallId: 'include-empty', messages: [], context: undefined };
    const empty = await executable(tools, 'search_files')(
      { query: 'needle', mode: 'content', include: '*.ts' },
      options,
    );
    expect(empty).toMatchObject({ matches: [], scannedFiles: 0 });
    expect(empty).not.toHaveProperty('hint');

    // And the other half of the same question: a file the HOST refused is not
    // the pattern's doing either.
    const guarded = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-guarded-'));
    roots.push(guarded);
    await writeFile(path.join(guarded, 'secret.ts'), 'export const needle = true;\n');
    const refusing = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root: guarded,
        authorize: () => true,
        authorizePath: ({ path: candidate }) => candidate === '.',
      }),
    });
    const refused = await executable(refusing, 'search_files')(
      { query: 'needle', mode: 'content', include: '**/*.ts' },
      { toolCallId: 'include-guarded', messages: [], context: undefined },
    );
    expect(refused).toMatchObject({ matches: [], scannedFiles: 0 });
    expect(refused).not.toHaveProperty('hint');
  });

  test('searches bounded content and applies one digest-guarded atomic patch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-patch-'));
    roots.push(root);
    await writeFile(path.join(root, 'source.txt'), 'alpha\nbeta\n');
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });
    const options = { toolCallId: 'patch', messages: [], context: undefined };
    expect(
      await executable(tools, 'search_files')({ query: 'beta', mode: 'content' }, options),
    ).toEqual({
      matches: [{ path: 'source.txt', line: 2, text: 'beta' }],
      truncated: false,
      scannedFiles: 1,
      skippedDirectories: 0,
      skippedSymlinks: 0,
    });
    const baseSha256 = createHash('sha256').update('alpha\nbeta\n').digest('hex');
    const dryRun = await executable(tools, 'edit_file')(
      {
        path: 'source.txt',
        expectedSha256: baseSha256,
        oldText: 'beta',
        newText: 'gamma',
        dryRun: true,
      },
      options,
    );
    expect(dryRun).toMatchObject({ path: 'source.txt', applied: false, replacements: 1 });
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('alpha\nbeta\n');
    expect(
      await executable(tools, 'edit_file')(
        {
          path: 'source.txt',
          expectedSha256: baseSha256,
          oldText: 'beta',
          newText: 'gamma',
          dryRun: false,
        },
        options,
      ),
    ).toMatchObject({ path: 'source.txt', applied: true, replacements: 1 });
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('alpha\ngamma\n');
    const originalError = console.error;
    console.error = () => undefined;
    const stale = executable(tools, 'edit_file')(
      {
        path: 'source.txt',
        expectedSha256: baseSha256,
        oldText: 'gamma',
        newText: 'stale',
        dryRun: false,
      },
      options,
    );
    console.error = originalError;
    await expect(stale).rejects.toMatchObject({ output: { error: 'CONFLICT' } });
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('alpha\ngamma\n');
  });

  test('searches an installed workspace without following dependency symlinks or runtime state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-search-'));
    roots.push(root);
    await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
    await mkdir(path.join(root, '.stitchkit'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(path.join(root, '.stitchkit', 'agent.sqlite'), 'not utf-8: \xff');
    await symlink('/usr/bin/printf', path.join(root, 'node_modules', '.bin', 'printf'));
    await symlink('/etc/passwd', path.join(root, 'outside-link'));
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });

    await expect(
      executable(tools, 'search_files')(
        { query: 'package.json', mode: 'path' },
        { toolCallId: 'search', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      matches: [{ path: 'package.json' }],
      truncated: false,
      scannedFiles: 1,
      skippedDirectories: 2,
      skippedSymlinks: 1,
    });
  });

  /**
   * A denied directory means the SAME thing on every surface.
   *
   * It did not. The walk refuses to descend into a denied directory, so denial
   * was recursive during discovery; direct access asked only about the leaf. A
   * host writing the obvious rule got a listing that hid `credentials` and a
   * `read_file` that served the secret inside it.
   *
   * And underneath that, a worse one: `contained-files` splits paths on
   * `[\\/]`, so `credentials\\token.txt` reached `openat` as two segments while
   * every callback was handed it as one name. That bypassed the REQUIRED
   * `authorize({ operation, path })` too — the one every consumer has had since
   * 0.70.0 — for reads and for writes.
   */
  test('a denied directory is denied on every surface, whatever the spelling', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-path-chain-'));
    roots.push(root);
    await mkdir(path.join(root, 'credentials', 'nested'), { recursive: true });
    await mkdir(path.join(root, 'credentials-backup'));
    await writeFile(path.join(root, 'credentials', 'token.txt'), 'SECRET_MARKER=token\n');
    await writeFile(
      path.join(root, 'credentials', 'nested', 'deep.txt'),
      'SECRET_MARKER=deep\n',
    );
    await writeFile(path.join(root, 'credentials-backup', 'note.txt'), 'ordinary\n');

    const asked: string[] = [];
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        authorizePath: ({ path: candidate }) => {
          asked.push(candidate);
          return candidate !== 'credentials';
        },
      }),
    });
    const options = { toolCallId: 'path-chain', messages: [], context: undefined };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const forbidden = { output: { error: 'FORBIDDEN' } };

      // Direct access, at the leaf and deeper.
      await expect(
        executable(tools, 'read_file')({ path: 'credentials/token.txt' }, options),
      ).rejects.toMatchObject(forbidden);
      await expect(
        executable(tools, 'read_file')({ path: 'credentials/nested/deep.txt' }, options),
      ).rejects.toMatchObject(forbidden);
      await expect(
        executable(tools, 'edit_file')(
          { path: 'credentials/token.txt', oldText: 'SECRET_MARKER=token', newText: 'x' },
          options,
        ),
      ).rejects.toMatchObject(forbidden);

      // A mutation that used to CREATE directories under a denied ancestor.
      await expect(
        executable(tools, 'write_file')(
          { path: 'credentials/created/new.txt', content: 'x' },
          options,
        ),
      ).rejects.toMatchObject(forbidden);
      expect(existsSync(path.join(root, 'credentials', 'created'))).toBe(false);

      // Discovery given a base path INSIDE the denied directory: it used to
      // list the contents, and `glob` used to answer with an empty result —
      // two refusal shapes for one policy decision.
      await expect(
        executable(tools, 'list_directory')({ path: 'credentials/nested' }, options),
      ).rejects.toMatchObject(forbidden);
      await expect(
        executable(tools, 'glob')({ path: 'credentials/nested', pattern: '**' }, options),
      ).rejects.toMatchObject(forbidden);

      // The spelling that bypassed every rule by changing one character.
      await expect(
        executable(tools, 'read_file')({ path: 'credentials\\token.txt' }, options),
      ).rejects.toMatchObject(forbidden);
      await expect(
        executable(tools, 'write_file')(
          { path: 'credentials\\token.txt', content: 'PWNED', overwrite: true },
          options,
        ),
      ).rejects.toMatchObject(forbidden);
      expect(await readFile(path.join(root, 'credentials', 'token.txt'), 'utf8')).toBe(
        'SECRET_MARKER=token\n',
      );

      // NEGATIVE CONTROL. Segment-wise, not `startsWith`: a rule denying
      // `credentials` must not also deny `credentials-backup`, and an
      // implementation that used string prefixes would pass everything above.
      const allowed = await executable(tools, 'read_file')(
        { path: 'credentials-backup/note.txt' },
        options,
      );
      expect(allowed.text).toBe('ordinary\n');

      // Outermost first, short-circuiting: nothing under a denied directory is
      // ever put to the policy.
      expect(asked).not.toContain('credentials/token.txt');
      expect(asked).toContain('credentials');
    } finally {
      console.error = originalError;
    }
  });

  /**
   * The chain asks about ANCESTORS, and the workspace root is not one.
   *
   * Asking `.` on every direct access looks symmetrical with the walk, which
   * does ask it — but there `.` is the base path the caller named. Asked
   * unconditionally it inverts every allow-list: a host exposing one subtree
   * answers `false` for a root it never meant to deny, and loses the subtree
   * too. This is the assertion that pins it; without one, removing the `.`
   * question changes nothing that any test can see.
   */
  test('an allow-list policy keeps working, and the workspace root is not asked about', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-allow-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'index.ts'), 'export const ordinary = true;\n');

    const asked: string[] = [];
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        // Exposing one subtree: `false` for everything else, `.` included.
        authorizePath: ({ path: candidate }) => {
          asked.push(candidate);
          return candidate.startsWith('src');
        },
      }),
    });
    const options = { toolCallId: 'allow-list', messages: [], context: undefined };

    const read = await executable(tools, 'read_file')({ path: 'src/index.ts' }, options);

    expect(read.text).toBe('export const ordinary = true;\n');
    expect(asked).toEqual(['src', 'src/index.ts']);
  });

  /**
   * `run_command` is outside the path POLICY on purpose — an executable needs
   * process isolation, not path filtering. It is not outside the path SHAPE:
   * accepting spellings here that every file tool refuses was an asymmetry with
   * no decision behind it, and `\\` in particular was the separator that
   * bypassed both callbacks everywhere else.
   */
  test('run_command cwd is held to the same path shape as every file tool', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-cwd-'));
    roots.push(root);
    await mkdir(path.join(root, 'work'));

    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf' },
      }),
    });
    const options = { toolCallId: 'cwd-shape', messages: [], context: undefined };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      for (const cwd of ['work\\nested', 'work/../work']) {
        await expect(
          executable(tools, 'run_command')(
            { executable: 'printf', args: ['x'], cwd },
            options,
          ),
        ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
      }
    } finally {
      console.error = originalError;
    }
  });

  test('applies one async path policy before direct access, discovery and search reads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-path-policy-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'credentials'));
    await writeFile(path.join(root, '.env'), 'SECRET_MARKER=env\n');
    await writeFile(path.join(root, 'credentials', 'token.txt'), 'SECRET_MARKER=token\n');
    await writeFile(path.join(root, 'src', 'ordinary.ts'), 'export const ordinary = true;\n');
    await writeFile(path.join(root, 'outside-include.txt'), 'ordinary but not included\n');
    await symlink('.env', path.join(root, 'public-link'));

    const admitted: string[] = [];
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        authorizePath: async ({ path: candidate }) => {
          admitted.push(candidate);
          await Promise.resolve();
          // EXACT, not `startsWith`. The prefix form was the one policy shape
          // where a leaf-only check and a recursive one agree, so it hid both
          // the ancestor gap and the separator gap this file now covers below.
          return candidate !== '.env' && candidate !== 'credentials';
        },
      }),
    });
    const options = { toolCallId: 'path-policy', messages: [], context: undefined };

    const content = await executable(tools, 'search_files')(
      { query: 'SECRET_MARKER', mode: 'content' },
      options,
    );
    expect(content.matches).toEqual([]);
    admitted.length = 0;
    const ordinary = await executable(tools, 'search_files')(
      { query: 'ordinary', mode: 'content', include: 'src/**' },
      options,
    );
    expect(ordinary.matches).toEqual([
      {
        path: path.join('src', 'ordinary.ts'),
        line: 1,
        text: 'export const ordinary = true;',
      },
    ]);
    expect(admitted).not.toContain('outside-include.txt');

    const paths = await executable(tools, 'search_files')(
      { query: '.', mode: 'path', regex: true },
      options,
    );
    expect(paths.matches.map(({ path: candidate }: { path: string }) => candidate)).toEqual([
      'outside-include.txt',
      path.join('src', 'ordinary.ts'),
    ]);
    const listing = await executable(tools, 'list_directory')({ path: '.' }, options);
    expect(listing.entries.map(({ name }: { name: string }) => name)).toEqual([
      'src',
      'outside-include.txt',
      'public-link',
    ]);
    const glob = await executable(tools, 'glob')({ pattern: '**' }, options);
    expect(glob.paths).toEqual(['outside-include.txt', path.join('src', 'ordinary.ts')]);

    // A path the host refuses is not an absent path: every discovery surface
    // names it, so a model cannot conclude `.env` is not there. Order is the
    // caller's, not asserted here.
    const deniedPaths = (entries: readonly { path: string }[]) =>
      entries.map(({ path: candidate }) => candidate).sort();
    expect(deniedPaths(listing.denied ?? [])).toEqual(['.env', 'credentials']);
    expect(deniedPaths(glob.denied ?? [])).toEqual(['.env', 'credentials']);
    expect(deniedPaths(content.denied ?? [])).toEqual(['.env', 'credentials']);
    // The host's refusals are kept apart from the include pattern's own.
    expect(content.denied).not.toContainEqual({ path: 'outside-include.txt', kind: 'file' });

    const originalError = console.error;
    console.error = () => undefined;
    await expect(
      executable(tools, 'read_file')({ path: '.env' }, options),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    await expect(
      executable(tools, 'write_file')(
        { path: '.env', content: 'changed', overwrite: true },
        options,
      ),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    await expect(
      executable(tools, 'edit_file')(
        { path: '.env', oldText: 'SECRET_MARKER=env', newText: 'changed' },
        options,
      ),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    await expect(
      executable(tools, 'read_file')({ path: 'public-link' }, options),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    console.error = originalError;
    expect(await readFile(path.join(root, '.env'), 'utf8')).toBe('SECRET_MARKER=env\n');
  });

  test('omits command execution when the host declares no executable aliases', () => {
    const definitions = createAgentCodingTools({ root: '/tmp', authorize: () => true });
    expect(definitions.map(({ name }) => name)).not.toContain('run_command');
  });

  test('serializes exact patch authorization and rejects a concurrent stale base', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-race-'));
    roots.push(root);
    await writeFile(path.join(root, 'source.txt'), 'base');
    const authorizations: AgentCodingToolAuthorization[] = [];
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: (request) => {
          authorizations.push(request);
          return true;
        },
      }),
    });
    const execute = executable(tools, 'edit_file');
    const options = { toolCallId: 'race', messages: [], context: undefined };
    const baseSha256 = createHash('sha256').update('base').digest('hex');
    const originalError = console.error;
    console.error = () => undefined;
    const results = await Promise.allSettled([
      execute(
        {
          path: 'source.txt',
          expectedSha256: baseSha256,
          oldText: 'base',
          newText: 'one',
          dryRun: false,
        },
        options,
      ),
      execute(
        {
          path: 'source.txt',
          expectedSha256: baseSha256,
          oldText: 'base',
          newText: 'two',
          dryRun: false,
        },
        options,
      ),
    ]);
    console.error = originalError;
    expect(
      results.filter((result) => result.status === 'fulfilled' && result.value.applied),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' && result.reason?.output?.error === 'CONFLICT',
      ),
    ).toHaveLength(1);
    expect(['one', 'two']).toContain(await readFile(path.join(root, 'source.txt'), 'utf8'));
    const patchAuthorizations = authorizations.filter(
      (request): request is Extract<AgentCodingToolAuthorization, { operation: 'edit' }> =>
        request.operation === 'edit',
    );
    // One, not two: the loser's stale digest is refused inside the lock BEFORE
    // the host is asked. Authorization describes a mutation that will happen,
    // and an edit built on a superseded read never will.
    expect(patchAuthorizations).toHaveLength(1);
    expect(patchAuthorizations.every((request) => request.resultBytes === 3)).toBe(true);
    expect(patchAuthorizations.every((request) => request.resultSha256.length === 64)).toBe(
      true,
    );
  });

  if (process.platform !== 'win32') {
    test('refuses read, new-file write and patch when authorization loses parent identity', async () => {
      const operation = async (kind: 'read' | 'write' | 'edit') => {
        const fixture = await mkdtemp(path.join(tmpdir(), `stitchkit-coding-parent-${kind}-`));
        roots.push(fixture);
        const root = path.join(fixture, 'workspace');
        const nested = path.join(root, 'nested');
        const original = path.join(root, 'original-nested');
        const outside = path.join(fixture, 'outside');
        await mkdir(root);
        await mkdir(nested);
        await mkdir(outside);
        await writeFile(path.join(nested, 'source.txt'), 'inside');
        await writeFile(path.join(outside, 'source.txt'), 'outside');
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const tools = mountAgent([], {
          runtimeTools: createAgentCodingTools({
            root,
            authorize: async () => {
              entered.resolve();
              await release.promise;
              return true;
            },
          }),
        });
        const options = { toolCallId: `parent-${kind}`, messages: [], context: undefined };
        const baseSha256 = createHash('sha256').update('inside').digest('hex');
        const call =
          kind === 'read'
            ? executable(tools, 'read_file')({ path: 'nested/source.txt' }, options)
            : kind === 'write'
              ? executable(tools, 'write_file')(
                  { path: 'nested/new.txt', content: 'escaped', overwrite: false },
                  options,
                )
              : executable(tools, 'edit_file')(
                  {
                    path: 'nested/source.txt',
                    expectedSha256: baseSha256,
                    oldText: 'inside',
                    newText: 'changed',
                    dryRun: false,
                  },
                  options,
                );
        const settled = call.then(
          (value: unknown) => ({ status: 'fulfilled', value }),
          (reason: unknown) => ({ status: 'rejected', reason }),
        );
        await entered.promise;
        await rename(nested, original);
        await symlink(outside, nested, 'dir');
        const originalError = console.error;
        console.error = () => undefined;
        release.resolve();
        const result = await settled;
        console.error = originalError;
        // Fails closed — that is the property. The code is no longer
        // `INTERNAL_SERVER_ERROR` for every one of these: an ordinary outcome now
        // says what it is, and a swapped parent reads as a segment that is not a
        // directory. What must never change is that the refusal happens and that
        // it names nothing outside the workspace.
        expect(result).toMatchObject({ status: 'rejected' });
        expect(String((result as { reason: unknown }).reason)).not.toContain(fixture);
        expect(await readFile(path.join(outside, 'source.txt'), 'utf8')).toBe('outside');
        expect(await readFile(path.join(original, 'source.txt'), 'utf8')).toBe('inside');
        expect(existsSync(path.join(outside, 'new.txt'))).toBeFalse();
        expect(existsSync(path.join(original, 'new.txt'))).toBeFalse();
      };

      await operation('read');
      await operation('write');
      await operation('edit');
    });

    test('search skips a parent replaced by an outside symlink after authorization', async () => {
      const fixture = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-search-parent-'));
      roots.push(fixture);
      const root = path.join(fixture, 'workspace');
      const nested = path.join(root, 'nested');
      const outside = path.join(fixture, 'outside');
      await mkdir(root);
      await mkdir(nested);
      await mkdir(outside);
      await writeFile(path.join(nested, 'inside.txt'), 'inside-only');
      await writeFile(path.join(outside, 'outside.txt'), 'outside-secret');
      const tools = mountAgent([], {
        runtimeTools: createAgentCodingTools({
          root,
          authorize: async (request) => {
            if (request.operation === 'search') {
              await rename(nested, path.join(root, 'original-nested'));
              await symlink(outside, nested, 'dir');
            }
            return true;
          },
        }),
      });
      const result = await executable(tools, 'search_files')(
        { query: 'outside-secret', mode: 'content' },
        { toolCallId: 'search-parent', messages: [], context: undefined },
      );
      expect(result.matches).toEqual([]);
      expect(result.skippedSymlinks).toBe(1);
    });
  }

  test('preserves large shell output behind an opaque readable artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-artifact-'));
    roots.push(root);
    const artifacts = new Map<string, Uint8Array>();
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf' },
        artifacts: {
          write: ({ data }) => {
            artifacts.set('artifact-1', data);
            return { reference: 'artifact-1' };
          },
          read: ({ reference, offset, maxBytes }) => {
            const data = artifacts.get(reference);
            if (!data) throw new Error('missing artifact');
            return {
              data: data.subarray(offset, offset + maxBytes),
              totalBytes: data.byteLength,
            };
          },
        },
        limits: { maxShellOutputBytes: 8, maxArtifactBytes: 128 },
      }),
    });
    const options = { toolCallId: 'artifact', messages: [], context: undefined };
    const output = await executable(tools, 'run_command')(
      { executable: 'printf', args: ['0123456789abcdef'] },
      options,
    );
    expect(output).toMatchObject({
      stdout: '0123cdef',
      outcome: 'exited',
      artifact: { reference: 'artifact-1', truncated: false },
    });
    expect(artifacts.get('artifact-1')?.byteLength).toBeLessThanOrEqual(128);
    expect(
      await executable(tools, 'read_output')(
        { reference: 'artifact-1', offset: 0, maxBytes: 64 },
        options,
      ),
    ).toMatchObject({
      reference: 'artifact-1',
      text: expect.stringContaining('0123456789abcdef'),
    });
  });

  test('preserves direct identities across bounded read, write, patch and command calls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-'));
    roots.push(root);
    await writeFile(path.join(root, 'source.txt'), 'alpha beta');
    const authorizations: AgentCodingToolAuthorization[] = [];
    const lifecycle: string[] = [];
    const definitions = createAgentCodingTools({
      root,
      authorize: (request) => {
        authorizations.push(request);
        return true;
      },
      executables: { printf: '/usr/bin/printf' },
      limits: {
        maxReadBytes: 64,
        maxWriteBytes: 64,
        maxShellOutputBytes: 64,
      },
    });
    const tools = mountAgent([], {
      runtimeTools: definitions,
      lifecycle: {
        beforeHandle: (_context, operation) => {
          if (!operation.toolName) throw new Error('expected direct coding tool identity');
          lifecycle.push(operation.toolName);
        },
      },
    });
    const options = { toolCallId: 'coding', messages: [], context: undefined };

    expect(
      await executable(tools, 'read_file')({ path: 'source.txt', maxBytes: 5 }, options),
    ).toEqual({
      path: 'source.txt',
      text: 'alpha',
      bytes: 5,
      sha256: createHash('sha256').update('alpha beta').digest('hex'),
      truncated: true,
      nextOffset: 5,
    });
    expect(
      await executable(tools, 'write_file')(
        { path: 'created.txt', content: 'one two' },
        options,
      ),
    ).toEqual({ path: 'created.txt', bytes: 7, createdDirectories: [] });
    expect(
      await executable(tools, 'edit_file')(
        {
          path: 'created.txt',
          expectedSha256: createHash('sha256').update('one two').digest('hex'),
          oldText: 'two',
          newText: 'three',
          dryRun: false,
        },
        options,
      ),
    ).toMatchObject({ path: 'created.txt', replacements: 1, bytes: 9, applied: true });
    expect(await readFile(path.join(root, 'created.txt'), 'utf8')).toBe('one three');
    expect(
      await executable(tools, 'run_command')(
        { executable: 'printf', args: ['shell-ok'] },
        options,
      ),
    ).toEqual({
      executable: 'printf',
      exitCode: 0,
      signal: null,
      stdout: 'shell-ok',
      stderr: '',
      outcome: 'exited',
    });

    expect(lifecycle).toEqual(['read_file', 'write_file', 'edit_file', 'run_command']);
    expect(authorizations.map(({ operation }) => operation)).toEqual([
      'read',
      'write',
      'edit',
      'shell',
    ]);
  });

  test('fails closed on denied operations, path escapes and symlink escapes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-outside-'));
    roots.push(root, outside);
    await writeFile(path.join(root, 'denied.txt'), 'unchanged');
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: (request) => request.operation === 'read',
      }),
    });
    const options = { toolCallId: 'denied', messages: [], context: undefined };
    const originalError = console.error;
    console.error = () => undefined;
    await expect(
      executable(tools, 'write_file')(
        { path: 'denied.txt', content: 'changed', overwrite: true },
        options,
      ),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    // Both escapes are still refused, and now they say so. An empty server
    // fault taught a model nothing about the one boundary it must learn.
    await expect(
      executable(tools, 'read_file')({ path: '../outside.txt' }, options),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    await expect(
      executable(tools, 'read_file')({ path: 'escape.txt' }, options),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    console.error = originalError;
    expect(await readFile(path.join(root, 'denied.txt'), 'utf8')).toBe('unchanged');
  });

  test('bounds shell output, timeout and cancellation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-shell-'));
    roots.push(root);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf', sleep: '/usr/bin/sleep' },
        limits: { maxShellOutputBytes: 8, shellTimeoutMs: 20 },
      }),
    });
    const options = { toolCallId: 'shell', messages: [], context: undefined };
    const limited = await executable(tools, 'run_command')(
      { executable: 'printf', args: ['0123456789abcdef'] },
      options,
    );
    expect(limited).toMatchObject({
      executable: 'printf',
      stdout: '01234567',
      outcome: 'output-limit',
    });
    const timedOut = await executable(tools, 'run_command')(
      { executable: 'sleep', args: ['1'] },
      options,
    );
    expect(timedOut).toMatchObject({ executable: 'sleep', outcome: 'timeout' });

    const controller = new AbortController();
    const cancelled = executable(tools, 'run_command')(
      { executable: 'sleep', args: ['1'] },
      {
        toolCallId: 'cancelled',
        messages: [],
        context: undefined,
        abortSignal: controller.signal,
      },
    );
    controller.abort();
    expect(await cancelled).toMatchObject({ executable: 'sleep', outcome: 'cancelled' });
  });

  test('run_command aligns the retained preview so a multi-byte cut leaves no replacement glyph', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-shell-utf8-'));
    roots.push(root);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf' },
        limits: { maxShellOutputBytes: 5 },
      }),
    });
    const output = await executable(tools, 'run_command')(
      { executable: 'printf', args: ['€€€'] },
      { toolCallId: 'shell-utf8', messages: [], context: undefined },
    );
    expect(output.stdout).not.toContain('\uFFFD');
    // The fifth byte falls inside the second character, so the preview is
    // pulled back to the first boundary (byte 3) rather than emitting half a
    // glyph; the dropped bytes are reported as omitted, not lost.
    expect(output).toMatchObject({ stdout: '€', outcome: 'output-limit' });
  });

  test('does not spawn a command for a pre-aborted invocation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-pre-abort-'));
    roots.push(root);
    const marker = path.join(root, 'spawned.txt');
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { bash: '/bin/bash' },
      }),
    });
    const controller = new AbortController();
    controller.abort();
    const result = await executable(tools, 'run_command')(
      { executable: 'bash', args: ['-c', 'printf spawned > "$1"', '--', marker] },
      {
        toolCallId: 'pre-aborted',
        messages: [],
        context: undefined,
        abortSignal: controller.signal,
      },
    );
    expect(result).toMatchObject({ executable: 'bash', outcome: 'cancelled' });
    expect(existsSync(marker)).toBeFalse();

    const brokenTools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { missing: path.join(root, 'missing-executable') },
        limits: { shellTimeoutMs: 20, shellTerminationGraceMs: 20 },
      }),
    });
    const originalError = console.error;
    console.error = () => undefined;
    const failedAt = performance.now();
    await expect(
      executable(brokenTools, 'run_command')(
        { executable: 'missing', args: [] },
        { toolCallId: 'spawn-error', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({ output: { error: 'INTERNAL_SERVER_ERROR' } });
    console.error = originalError;
    expect(performance.now() - failedAt).toBeLessThan(500);
  });

  if (process.platform !== 'win32') {
    test('kills owned descendants and bounds retained pipes on exit, timeout, abort and output limit', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-process-group-'));
      roots.push(root);
      const tools = mountAgent([], {
        runtimeTools: createAgentCodingTools({
          root,
          authorize: () => true,
          executables: { bash: '/bin/bash' },
          limits: {
            maxShellOutputBytes: 64,
            shellTimeoutMs: 40,
            shellTerminationGraceMs: 80,
          },
        }),
      });
      const options = { toolCallId: 'process-group', messages: [], context: undefined };

      const startedAt = performance.now();
      const timedOut = ShellOutputSchema.parse(
        await executable(tools, 'run_command')(
          { executable: 'bash', args: ['-c', 'sleep 10 & echo $!; wait'] },
          options,
        ),
      );
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(timedOut).toMatchObject({ executable: 'bash', outcome: 'timeout' });
      const timeoutPid = Number(timedOut.stdout.trim());
      expect(Number.isSafeInteger(timeoutPid)).toBeTrue();
      await expectProcessGone(timeoutPid);

      const controller = new AbortController();
      const abortStartedAt = performance.now();
      const cancelled = executable(tools, 'run_command')(
        { executable: 'bash', args: ['-c', 'sleep 10 & echo $!; wait'] },
        {
          toolCallId: 'process-group-abort',
          messages: [],
          context: undefined,
          abortSignal: controller.signal,
        },
      );
      setTimeout(() => controller.abort(), 20);
      const cancelledResult = ShellOutputSchema.parse(await cancelled);
      expect(performance.now() - abortStartedAt).toBeLessThan(500);
      expect(cancelledResult).toMatchObject({ executable: 'bash', outcome: 'cancelled' });
      const cancelledPid = Number(cancelledResult.stdout.trim());
      expect(Number.isSafeInteger(cancelledPid)).toBeTrue();
      await expectProcessGone(cancelledPid);

      const exitedAt = performance.now();
      const exited = ShellOutputSchema.parse(
        await executable(tools, 'run_command')(
          { executable: 'bash', args: ['-c', 'sleep 10 & echo $!'] },
          options,
        ),
      );
      expect(performance.now() - exitedAt).toBeLessThan(500);
      expect(exited).toMatchObject({ executable: 'bash', outcome: 'exited', exitCode: 0 });
      const exitedPid = Number(exited.stdout.trim());
      expect(Number.isSafeInteger(exitedPid)).toBeTrue();
      await expectProcessGone(exitedPid);

      const limitedTools = mountAgent([], {
        runtimeTools: createAgentCodingTools({
          root,
          authorize: () => true,
          executables: { bash: '/bin/bash' },
          limits: {
            maxShellOutputBytes: 4,
            shellTimeoutMs: 2_000,
            shellTerminationGraceMs: 80,
          },
        }),
      });
      const limitedAt = performance.now();
      const limited = ShellOutputSchema.parse(
        await executable(limitedTools, 'run_command')(
          { executable: 'bash', args: ['-c', 'printf 12345; sleep 10 & wait'] },
          options,
        ),
      );
      expect(performance.now() - limitedAt).toBeLessThan(500);
      expect(limited).toMatchObject({ executable: 'bash', outcome: 'output-limit' });
    });
  }

  test('rejects shell arguments whose aggregate encoding exceeds its byte budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-args-'));
    roots.push(root);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf' },
        limits: { maxShellArgumentBytes: 4 },
      }),
    });
    const originalError = console.error;
    console.error = () => undefined;
    await expect(
      executable(tools, 'run_command')(
        { executable: 'printf', args: ['12345'] },
        { toolCallId: 'args', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({ output: { error: 'INTERNAL_SERVER_ERROR' } });
    console.error = originalError;
  });

  test('read_file resumes on a character boundary instead of refusing a multi-byte slice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-utf8-'));
    roots.push(root);
    // Three bytes per character, so a byte window lands inside one at offsets
    // that used to make the fatal decoder answer INTERNAL_SERVER_ERROR.
    const content = '€'.repeat(6);
    await writeFile(path.join(root, 'euro.txt'), content);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });
    const options = { toolCallId: 'utf8', messages: [], context: undefined };

    // A window smaller than one character must still make progress: the slice
    // is extended to the whole character rather than trimmed to nothing.
    const single = await executable(tools, 'read_file')(
      { path: 'euro.txt', offset: 0, maxBytes: 1 },
      options,
    );
    expect(single).toMatchObject({ text: '€', bytes: 3, truncated: true, nextOffset: 3 });

    let offset = 0;
    let stitched = '';
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await executable(tools, 'read_file')(
        { path: 'euro.txt', offset, maxBytes: 4 },
        options,
      );
      expect(page.text).not.toContain('\uFFFD');
      stitched += page.text;
      if (!page.truncated) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(stitched).toBe(content);
  });

  test('read_file resumes past a mid-character offset instead of refusing the slice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-utf8-start-'));
    roots.push(root);
    // Three bytes per character: offsets 1 and 2 land on the continuation
    // bytes of the FIRST character. The end was aligned but the start was not,
    // so the fatal decoder received a bare fragment and the call surfaced as
    // INTERNAL_SERVER_ERROR.
    const content = '€€€';
    await writeFile(path.join(root, 'euro.txt'), content);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });
    const options = { toolCallId: 'utf8-start', messages: [], context: undefined };

    for (const offset of [1, 2]) {
      const page = await executable(tools, 'read_file')(
        { path: 'euro.txt', offset, maxBytes: 64 },
        options,
      );
      expect(page.text).not.toContain('\uFFFD');
      // Resumes at the next character boundary (byte 3), not at the raw offset.
      expect(page).toMatchObject({ text: '€€', bytes: 6, truncated: false });
    }
  });

  test('names paths the host policy refuses instead of dropping them from discovery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-denied-'));
    roots.push(root);
    await mkdir(path.join(root, 'kept'));
    await writeFile(path.join(root, 'visible.txt'), 'nothing secret here\n');
    await writeFile(path.join(root, '.env'), 'SECRET_MARKER=1\n');
    await mkdir(path.join(root, 'private'));
    await writeFile(path.join(root, 'private', 'token.txt'), 'SECRET_MARKER=2\n');
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        authorizePath: ({ path: candidate }) =>
          candidate !== '.env' && candidate !== 'private',
      }),
    });
    const options = { toolCallId: 'denied', messages: [], context: undefined };

    const listing = await executable(tools, 'list_directory')({ path: '.' }, options);
    expect(listing.entries.map(({ name }: { name: string }) => name)).toEqual([
      'kept',
      'visible.txt',
    ]);
    expect(listing.denied).toEqual([
      { path: '.env', kind: 'file' },
      { path: 'private', kind: 'directory' },
    ]);

    const glob = await executable(tools, 'glob')({ pattern: '**' }, options);
    expect(glob.paths).toEqual(['visible.txt']);
    expect(glob.denied).toEqual([
      { path: '.env', kind: 'file' },
      { path: 'private', kind: 'directory' },
    ]);

    const search = await executable(tools, 'search_files')(
      { query: 'visible', mode: 'path' },
      options,
    );
    expect(search.matches).toEqual([{ path: 'visible.txt' }]);
    expect(search.denied).toEqual([
      { path: '.env', kind: 'file' },
      { path: 'private', kind: 'directory' },
    ]);
  });

  test('glob scopes denied entries to the requested path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-glob-denied-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, '.env'), 'SECRET_MARKER=root\n');
    await writeFile(path.join(root, 'src', 'secret.env'), 'SECRET_MARKER=inner\n');
    await writeFile(path.join(root, 'src', 'allowed.ts'), 'export const allowed = true;\n');
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        authorizePath: ({ path: candidate }) =>
          candidate !== '.env' && candidate !== path.join('src', 'secret.env'),
      }),
    });
    const options = { toolCallId: 'glob-denied', messages: [], context: undefined };

    const glob = await executable(tools, 'glob')({ pattern: '*.ts', path: 'src' }, options);
    expect(glob.paths).toEqual([path.join('src', 'allowed.ts')]);
    // The root refusal lies outside the requested path and must not be named;
    // the refusal inside `src` still is.
    expect(glob.denied).toEqual([{ path: path.join('src', 'secret.env'), kind: 'file' }]);
  });
});
