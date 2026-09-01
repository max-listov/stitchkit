import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { createAgentHarnessFileResources } from 'stitchkit/agent-runtime/harness';
import { mountAgent } from 'stitchkit/tools';

const roots = [];
const options = { toolCallId: 'contained-files', messages: [], context: undefined };
const execute = (tools, name) => {
  const operation = tools[name]?.execute;
  assert.equal(typeof operation, 'function', `missing ${name}`);
  return operation;
};

async function ordinaryOperations() {
  const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-contained-packed-'));
  roots.push(root);
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'root.txt'), 'root value');
  await writeFile(path.join(root, 'nested', 'file.txt'), 'nested value');
  const authorizations = [];
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root,
      authorize: (request) => {
        authorizations.push(request.operation);
        return true;
      },
    }),
  });
  const read = execute(tools, 'read_file');
  const write = execute(tools, 'write_file');
  const edit = execute(tools, 'edit_file');
  const search = execute(tools, 'search_files');

  assert.equal((await read({ path: 'root.txt' }, options)).text, 'root value');
  assert.equal((await read({ path: 'nested/file.txt' }, options)).text, 'nested value');
  await write({ path: 'nested/new.txt', content: 'created', overwrite: false }, options);
  await write({ path: 'nested/new.txt', content: 'overwritten', overwrite: true }, options);
  // One call, no digest and no dry-run round trip: `oldText` is itself the
  // freshness guard for the region being changed.
  const edited = await edit(
    { path: 'nested/file.txt', oldText: 'nested', newText: 'patched' },
    options,
  );
  assert.equal(edited.applied, true);
  assert.equal(edited.replacements, 1);
  // A content match now carries the line itself, so a model does not have to
  // read the file back to see what it found.
  assert.deepEqual(
    (await search({ query: 'patched value', mode: 'content' }, options)).matches,
    [{ path: path.join('nested', 'file.txt'), line: 1, text: 'patched value' }],
  );
  // The digest the edit returned chains the next one without re-reading.
  const chained = await edit(
    {
      path: 'nested/file.txt',
      expectedSha256: edited.sha256,
      oldText: 'patched value',
      newText: 'chained value',
    },
    options,
  );
  assert.equal(chained.applied, true);
  assert.equal(await readFile(path.join(root, 'nested', 'file.txt'), 'utf8'), 'chained value');
  assert.equal(await readFile(path.join(root, 'nested', 'new.txt'), 'utf8'), 'overwritten');

  const instructions = path.join(root, 'instructions');
  const skills = path.join(root, 'skills');
  await mkdir(instructions);
  await mkdir(path.join(skills, 'inspect'), { recursive: true });
  await writeFile(path.join(instructions, 'AGENTS.md'), 'Use contained resources.');
  await writeFile(
    path.join(skills, 'inspect', 'SKILL.md'),
    '---\nname: inspect\ndescription: Inspect contained files.\n---\n\nExact body.',
  );
  const resources = createAgentHarnessFileResources({
    roots: [
      { id: 'instructions', path: instructions, kind: 'instruction' },
      { id: 'skills', path: skills, kind: 'skill' },
    ],
  });
  const loaded = await resources.load();
  assert.equal(loaded.resources.length, 2);
  assert.equal(
    loaded.resources.find(({ name }) => name === 'inspect')?.text.includes('Exact body'),
    false,
  );
  const readResource = resources.runtimeTools.find(({ name }) => name === 'read_resource');
  assert.ok(readResource);
  const exact = await readResource.handler({ params: undefined, input: { name: 'inspect' } });
  assert.equal(exact.text.includes('Exact body'), true);
  assert.ok(authorizations.includes('read'));
  assert.ok(authorizations.includes('write'));
  assert.ok(authorizations.includes('edit'));
  assert.ok(authorizations.includes('search'));
}

async function parentSwap(kind) {
  const fixture = await mkdtemp(path.join(tmpdir(), `stitchkit-contained-race-${kind}-`));
  roots.push(fixture);
  const root = path.join(fixture, 'workspace');
  const nested = path.join(root, 'nested');
  const original = path.join(root, 'original');
  const outside = path.join(fixture, 'outside');
  await mkdir(root);
  await mkdir(nested);
  await mkdir(outside);
  await writeFile(path.join(nested, 'source.txt'), 'same content');
  await writeFile(path.join(outside, 'source.txt'), 'same content');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
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
  const call =
    kind === 'read'
      ? execute(tools, 'read_file')({ path: 'nested/source.txt' }, options)
      : execute(tools, 'edit_file')(
          { path: 'nested/source.txt', oldText: 'same', newText: 'changed' },
          options,
        );
  const settled = call.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
  await entered.promise;
  await rename(nested, original);
  await symlink(outside, nested, 'dir');
  release.resolve();
  const result = await settled;
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason.output.error, 'INTERNAL_SERVER_ERROR');
  assert.equal(await readFile(path.join(outside, 'source.txt'), 'utf8'), 'same content');
  assert.equal(await readFile(path.join(original, 'source.txt'), 'utf8'), 'same content');
  assert.equal(existsSync(path.join(outside, 'new.txt')), false);
}

try {
  await ordinaryOperations();
  await parentSwap('read');
  await parentSwap('edit');
  console.log(`packed contained files (${process.platform}/${process.arch}): ok`);
} finally {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
