import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const options = { toolCallId: 'contained-entries', messages: [], context: undefined };
const execute = (tools, name) => {
  const tool = tools[name];
  assert.ok(tool?.execute, `missing tool ${name}`);
  return tool.execute;
};
const refuses = (error, code, message) => {
  assert.equal(error.output.error, code);
  assert.match(error.output.details.message, message);
  return true;
};

/**
 * Entry-name, special-file, directory-plan and write-refusal controls of the public coding tools.
 * The caller supplies the entrypoints: packed proofs import the package, the regression imports
 * source, and both run this one matrix in a child a blocked open cannot hang.
 */
export async function entryBoundaryControls({ createAgentCodingTools, mountAgent }) {
  const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-entry-packed-'));
  try {
    await writeFile(path.join(root, 'secret'), 'unchanged');
    const asked = [];
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => {
          asked.push('operation');
          return true;
        },
        authorizePath: ({ path: candidate }) => {
          asked.push(candidate);
          return candidate !== 'secret';
        },
      }),
    });
    for (const candidate of ['secret\0allowed', 'secret\0allowed/file']) {
      for (const [name, input] of [
        ['read_file', { path: candidate }],
        ['write_file', { path: candidate, content: 'changed', overwrite: true }],
        ['edit_file', { path: candidate, oldText: 'unchanged', newText: 'changed' }],
        ['list_directory', { path: candidate }],
        ['glob', { path: candidate, pattern: '**' }],
      ]) {
        await assert.rejects(execute(tools, name)(input, options), (error) =>
          refuses(error, 'BAD_REQUEST', /NUL/),
        );
      }
    }
    assert.deepEqual(asked, []);
    assert.equal(await readFile(path.join(root, 'secret'), 'utf8'), 'unchanged');
    await writeFile(path.join(root, 'allowed'), 'ordinary');
    assert.equal(
      (await execute(tools, 'read_file')({ path: 'allowed' }, options)).text,
      'ordinary',
    );
    assert.deepEqual(asked, ['allowed', 'operation']);

    const plans = [];
    const planned = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: (request) => {
          if (request.operation === 'write') plans.push([...request.createsDirectories]);
          return true;
        },
      }),
    });
    const writer = execute(planned, 'write_file');
    await writer({ path: 'approved/nested/file', content: 'first' }, options);
    await writer(
      { path: 'approved/nested/file', content: 'created', overwrite: true },
      options,
    );
    assert.deepEqual(plans, [['approved', path.join('approved', 'nested')], []]);
    assert.equal(await readFile(path.join(root, 'approved/nested/file'), 'utf8'), 'created');
    for (const missingChild of [false, true]) {
      const ancestor = missingChild ? 'with-child' : 'existing';
      await mkdir(path.join(root, ancestor));
      const guarded = mountAgent([], {
        runtimeTools: createAgentCodingTools({
          root,
          authorize: async (request) => {
            assert.equal(request.operation, 'write');
            assert.deepEqual(
              request.createsDirectories,
              missingChild ? [path.join(ancestor, 'new')] : [],
            );
            await rename(path.join(root, ancestor), path.join(root, `${ancestor}-moved`));
            return true;
          },
        }),
      });
      await assert.rejects(
        execute(guarded, 'write_file')(
          {
            path: missingChild ? `${ancestor}/new/file` : `${ancestor}/file`,
            content: 'denied',
          },
          options,
        ),
        (error) => refuses(error, 'CONFLICT', /plan changed/),
      );
      assert.equal(existsSync(path.join(root, ancestor)), false);
      assert.deepEqual(await readdir(path.join(root, `${ancestor}-moved`)), []);
    }

    // What occupies the path is named on every platform, never an empty internal error.
    await mkdir(path.join(root, 'occupied'));
    await writeFile(path.join(root, 'occupied/kept'), 'kept');
    await assert.rejects(
      writer({ path: 'occupied', content: 'x', overwrite: true }, options),
      (error) => refuses(error, 'CONFLICT', /is a directory/),
    );
    assert.equal(await readFile(path.join(root, 'occupied/kept'), 'utf8'), 'kept');
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('.stitchkit-')),
      [],
    );
    await symlink(path.join(root, 'occupied'), path.join(root, 'linked'));
    await assert.rejects(writer({ path: 'linked/file', content: 'x' }, options), (error) => {
      assert.ok(['CONFLICT', 'FORBIDDEN'].includes(error.output.error));
      return true;
    });
    assert.equal(existsSync(path.join(root, 'occupied/file')), false);

    // A file the host refuses is no oracle, and what moved during the host's answer is a conflict.
    await writeFile(path.join(root, 'refused'), 'secret guess');
    const guarded = (authorize) =>
      execute(
        mountAgent([], { runtimeTools: createAgentCodingTools({ root, authorize }) }),
        'edit_file',
      );
    for (const oldText of ['secret', 'wrong']) {
      await assert.rejects(
        guarded(({ operation }) => operation !== 'read')(
          { path: 'refused', oldText, newText: 'x' },
          options,
        ),
        (error) => refuses(error, 'FORBIDDEN', /denied/),
      );
    }
    await assert.rejects(
      guarded(async ({ operation }) => {
        if (operation === 'edit')
          await writeFile(path.join(root, 'refused'), 'changed meanwhile');
        return true;
      })({ path: 'refused', oldText: 'secret', newText: 'x' }, options),
      (error) => refuses(error, 'CONFLICT', /changed since it was read/),
    );
    assert.equal(await readFile(path.join(root, 'refused'), 'utf8'), 'changed meanwhile');
    await mkdir(path.join(root, 'moved-away'));
    await writeFile(path.join(root, 'moved-away/file'), 'before');
    await assert.rejects(
      execute(
        mountAgent([], {
          runtimeTools: createAgentCodingTools({
            root,
            authorize: async () => {
              await rename(path.join(root, 'moved-away'), path.join(root, 'gone'));
              return true;
            },
          }),
        }),
        'read_file',
      )({ path: 'moved-away/file' }, options),
      (error) => refuses(error, 'CONFLICT', /changed while it was being authorized/),
    );

    // A rule on the stored name cannot be passed by another spelling, where the volume folds case.
    await mkdir(path.join(root, 'Guarded'));
    await writeFile(path.join(root, 'Guarded/token'), 'stored');
    const folds = existsSync(path.join(root, 'gUARDED'));
    const spelled = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        authorizePath: ({ path: candidate }) => candidate !== 'Guarded',
      }),
    });
    await assert.rejects(
      execute(spelled, 'read_file')({ path: 'gUARDED/token' }, options),
      (error) =>
        folds
          ? refuses(error, 'BAD_REQUEST', /stored on disk/)
          : refuses(error, 'NOT_FOUND', /does not exist/),
    );
    if (!folds) {
      await mkdir(path.join(root, 'guarded'));
      await writeFile(path.join(root, 'guarded/token'), 'distinct');
      assert.equal(
        (await execute(spelled, 'read_file')({ path: 'guarded/token' }, options)).text,
        'distinct',
      );
    }

    // New content inherits permission bits, never setuid or setgid.
    await writeFile(path.join(root, 'privileged'), 'old');
    await chmod(path.join(root, 'privileged'), 0o6755);
    await writer({ path: 'privileged', content: 'new', overwrite: true }, options);
    assert.equal((await stat(path.join(root, 'privileged'))).mode & 0o7777, 0o755);

    // A socket cannot be opened at all, and is named like any other special file.
    const socketPath = path.join(root, 'socket');
    const server = createServer();
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      await assert.rejects(
        execute(planned, 'read_file')({ path: 'socket' }, options),
        (error) => refuses(error, 'BAD_REQUEST', /not a regular file/),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // Ancestors of a root need search permission, never read; the superuser has both regardless.
    if (process.getuid?.() === 0) {
      console.log('search-only ancestor control skipped: the superuser bypasses permissions');
    } else {
      const ancestor = path.join(root, 'search-only');
      const workspace = path.join(ancestor, 'workspace');
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, 'file'), 'searched');
      const nested = mountAgent([], {
        runtimeTools: createAgentCodingTools({ root: workspace, authorize: () => true }),
      });
      try {
        await chmod(ancestor, 0o311);
        const reader = execute(nested, 'read_file');
        assert.equal((await reader({ path: 'file' }, options)).text, 'searched');
        await execute(nested, 'write_file')({ path: 'written', content: 'ok' }, options);
        await chmod(ancestor, 0o600);
        await assert.rejects(reader({ path: 'file' }, options));
      } finally {
        await chmod(ancestor, 0o700);
      }
    }

    // The enclosing proof owns this bounded child in its process group.
    execFileSync('mkfifo', [path.join(root, 'pipe')], { timeout: 1000 });
    await execute(planned, 'edit_file')(
      { path: 'approved/nested/file', oldText: 'created', newText: 'edited' },
      options,
    );
    for (const [name, input] of [
      ['read_file', { path: 'pipe' }],
      ['edit_file', { path: 'pipe', oldText: 'anything', newText: 'changed' }],
    ]) {
      await assert.rejects(execute(planned, name)(input, options), (error) =>
        refuses(error, 'BAD_REQUEST', /not a regular file/),
      );
    }
    assert.equal(await readFile(path.join(root, 'approved/nested/file'), 'utf8'), 'edited');
    console.log('packed contained entry boundaries: ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
