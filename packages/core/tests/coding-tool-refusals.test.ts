/**
 * Guard: an ordinary outcome of a coding tool never looks like a server fault.
 *
 * Every refusal these tools make used to be a plain `Error`, and
 * `toolResultFromError` scrubs anything that is not an `AppError` down to a bare
 * `INTERNAL_SERVER_ERROR`. A missing file, an ambiguous snippet and a file that
 * already exists all arrived as the same empty failure; in the run that
 * prompted this, a model met two of them, concluded writing was unavailable,
 * and stopped writing code.
 *
 * Fixing the cases one at a time drifts — the next tool throws `new Error`
 * again. So the check is mechanical, in the shape `option-effects` already
 * uses: the tools are enumerated from `AGENT_CODING_TOOL_NAMES`, and one with
 * no registered refusal is a red gate.
 *
 * It asserts the SERIALIZED model-facing envelope, not just the code. That is
 * not belt-and-braces: `toolResultFromError` renders
 * `details: appErr.details ?? { message }`, so structured details displace the
 * message entirely, and the natural way to write an informative refusal — a
 * count plus a sentence — would have reached the model as `{"occurrences":3}`
 * with no sentence. A gate checking only the code is green on exactly that.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_CODING_TOOL_NAMES,
  createAgentCodingTools,
} from '../src/agent-runtime/coding-tools';
import { mountAgent } from '../src/tools/agent';

let root = '';
let tools: ReturnType<typeof mountAgent>;
const options = { toolCallId: 'refusal', messages: [], context: undefined };

/** One refusal case: what to call, and what the model must be able to read. */
interface RefusalCase {
  readonly tool: string;
  readonly what: string;
  readonly input: Record<string, unknown>;
  readonly code: string;
  /** A fragment of the sentence the model receives; proves it survived the envelope. */
  readonly says: string;
}

const CASES: readonly RefusalCase[] = [
  {
    tool: 'read_file',
    what: 'a path that is not there',
    input: { path: 'missing.ts' },
    code: 'NOT_FOUND',
    says: 'does not exist',
  },
  {
    tool: 'read_file',
    what: 'a path leaving the root',
    input: { path: '../escape.ts' },
    code: 'FORBIDDEN',
    says: 'must name real entries',
  },
  {
    tool: 'read_file',
    what: 'an absolute path',
    input: { path: '/etc/passwd' },
    code: 'BAD_REQUEST',
    says: 'must be relative',
  },
  {
    tool: 'read_file',
    what: 'a directory',
    input: { path: 'nested' },
    code: 'BAD_REQUEST',
    says: 'not a regular file',
  },
  {
    tool: 'write_file',
    what: 'an existing file without overwrite',
    input: { path: 'existing.ts', content: 'x' },
    code: 'CONFLICT',
    says: 'already exists',
  },
  {
    tool: 'write_file',
    what: 'a symlink target',
    input: { path: 'link.ts', content: 'x', overwrite: true },
    code: 'FORBIDDEN',
    says: 'symlink',
  },
  {
    tool: 'write_file',
    what: 'a segment occupied by a file',
    input: { path: 'existing.ts/child.ts', content: 'x' },
    code: 'CONFLICT',
    says: 'not a directory',
  },
  {
    tool: 'edit_file',
    what: 'a snippet that is not present',
    input: { path: 'existing.ts', oldText: 'absent', newText: 'x' },
    code: 'NOT_FOUND',
    says: 'does not appear',
  },
  {
    tool: 'edit_file',
    what: 'a snippet that is ambiguous',
    input: { path: 'repeated.ts', oldText: 'same', newText: 'x' },
    code: 'CONFLICT',
    says: 'times',
  },
  {
    tool: 'edit_file',
    what: 'a digest that no longer matches',
    input: {
      path: 'existing.ts',
      oldText: 'kept',
      newText: 'x',
      expectedSha256: '0'.repeat(64),
    },
    code: 'CONFLICT',
    says: 'changed since it was read',
  },
  {
    tool: 'list_directory',
    what: 'a directory that is not there',
    input: { path: 'missing' },
    code: 'NOT_FOUND',
    says: 'does not exist',
  },
  {
    tool: 'list_directory',
    what: 'a file',
    input: { path: 'existing.ts' },
    code: 'BAD_REQUEST',
    says: 'not a directory',
  },
  {
    // Not "a pattern that cannot compile": the subset escapes everything outside
    // `**`, `*` and `?`, so `[` matches a literal bracket and compiling always
    // succeeds. The refusal glob does own is the workspace boundary.
    tool: 'glob',
    what: 'a search root outside the workspace',
    input: { pattern: '*.ts', path: '../elsewhere' },
    code: 'FORBIDDEN',
    says: 'must name real entries',
  },
  {
    tool: 'search_files',
    what: 'a regex construct that cannot be bounded',
    input: { query: '(a)\\1', regex: true },
    code: 'BAD_REQUEST',
    says: 'does not allow',
  },
  {
    tool: 'search_files',
    what: 'a regex that does not parse',
    input: { query: '(unclosed', regex: true },
    code: 'BAD_REQUEST',
    says: 'not a valid regular expression',
  },
];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'coding-refusals-'));
  await writeFile(path.join(root, 'existing.ts'), 'kept');
  await writeFile(path.join(root, 'repeated.ts'), 'same same');
  await symlink(path.join(root, 'existing.ts'), path.join(root, 'link.ts'));
  await writeFile(path.join(root, 'nested-file.ts'), 'x');
  await Bun.$`mkdir -p ${path.join(root, 'nested')}`.quiet();
  tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
  });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** The envelope the model actually receives, as one string. */
async function refusalOf(tool: string, input: Record<string, unknown>): Promise<string> {
  const mounted = tools[tool];
  if (!mounted?.execute) throw new Error(`${tool} is not mounted`);
  try {
    await mounted.execute(input, options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${tool} did not refuse ${JSON.stringify(input)}`);
}

describe('an ordinary coding-tool outcome never looks like a server fault', () => {
  test('every mounted coding tool has at least one registered refusal', () => {
    // Mechanical, so a new tool cannot arrive without one. `read_output` and
    // `run_command` are absent from this profile (no artifact store, no declared
    // executables) and are therefore not mounted at all.
    const mounted = Object.values(AGENT_CODING_TOOL_NAMES).filter((name) => name in tools);
    const covered = new Set(CASES.map((entry) => entry.tool));
    expect(mounted.filter((name) => !covered.has(name))).toEqual([]);
  });

  for (const entry of CASES) {
    test(`${entry.tool} refuses ${entry.what} in words`, async () => {
      const envelope = await refusalOf(entry.tool, entry.input);
      expect(envelope).toContain(`"${entry.code}"`);
      expect(envelope).not.toContain('INTERNAL_SERVER_ERROR');
      // The sentence, in the envelope the model reads — not merely in a message
      // the renderer was free to drop.
      expect(envelope).toContain(entry.says);
    });
  }

  test('a host-level cause is still scrubbed to an internal error', async () => {
    // The other direction of the same boundary. A root that disappeared is not
    // something a model can act on, and its cause must not leave the process.
    const gone = path.join(root, 'gone');
    const detached = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root: gone, authorize: () => true }),
    });
    const original = console.error;
    console.error = () => undefined;
    try {
      await detached.read_file?.execute?.({ path: 'anything.ts' }, options);
      throw new Error('a missing root must refuse');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('INTERNAL_SERVER_ERROR');
      expect(message).not.toContain(gone);
    } finally {
      console.error = original;
    }
  });
});
