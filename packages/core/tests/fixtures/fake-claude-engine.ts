/**
 * A scripted Claude Code for the driver's conformance: answers `--version`
 * and `auth status` as the CLI does, and plays the scenario in
 * `FAKE_ENGINE_SCENARIO` (a JSON file) on `stream-json`, keeping each input's
 * uuid in the profile's transcript the way the CLI does.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeTranscriptPath } from '../../src/agent-executor/claude/transcript';
import { runFakeClaudeEngine } from '../../src/agent-executor/testing/fake-claude-engine';

if (process.env.FAKE_ENGINE_PID_FILE !== undefined) {
  mkdirSync(dirname(process.env.FAKE_ENGINE_PID_FILE), { recursive: true });
  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, String(process.pid));
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(
    `${process.env.FAKE_CLAUDE_AUTH_STATUS ?? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })}\n`,
  );
  process.exit(0);
}
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const sessionId = flag('--session-id') ?? flag('--resume') ?? 'unknown';
const home = process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent';
const transcript = claudeTranscriptPath({ home, cwd: process.cwd(), sessionId });
mkdirSync(home, { recursive: true });
appendFileSync(`${home}/argv.jsonl`, `${JSON.stringify(args)}\n`);
const scenarioPath = process.env.FAKE_ENGINE_SCENARIO;
if (scenarioPath === undefined) throw new Error('FAKE_ENGINE_SCENARIO is required');
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
/** Every line the executor wrote, kept where a test can read what it answered. */
const lines: AsyncIterator<string> = {
  async next() {
    const next = await input.next();
    if (!next.done) appendFileSync(`${home}/stdin.jsonl`, `${next.value}\n`);
    return next;
  },
};
await runFakeClaudeEngine({
  scenario: JSON.parse(readFileSync(scenarioPath, 'utf8')),
  lines,
  write: (line) => process.stdout.write(`${line}\n`),
  onInput(uuid) {
    mkdirSync(dirname(transcript), { recursive: true });
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', uuid, sessionId })}\n`);
  },
  exit: (code) => process.exit(code),
  crash: () => process.kill(process.pid, 'SIGKILL') as never,
});
