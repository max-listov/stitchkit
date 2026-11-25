/**
 * What a driver regression test needs around a scripted engine: the fake engines' paths, a
 * scratch root, a scenario file, the engine's recorded lines, and a pid file registered with the
 * reaper before the engine can write it.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeEngineStep } from '../../src/agent-executor/testing/fake-engine';
import type { ExecutorDelta } from '../../src/agent-executor/vocabulary';
import { trackPidFile } from './process-reaper';

export const FAKE_ACP = fileURLToPath(
  new URL('../fixtures/fake-acp-agent.ts', import.meta.url),
);
export const FAKE_CLAUDE = fileURLToPath(
  new URL('../fixtures/fake-claude-engine.ts', import.meta.url),
);
export const FAKE_CODEX = fileURLToPath(
  new URL('../fixtures/fake-codex-engine.ts', import.meta.url),
);

/** The environment a driver passes its engine: this process's PATH and a scratch HOME. */
export function ambientIn(root: string): { PATH: string | undefined; HOME: string } {
  return { PATH: process.env.PATH, HOME: root };
}

/** A fresh scratch directory for `body`, removed however it ends. */
export async function inScratch<T>(
  prefix: string,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `stitchkit-${prefix}-`));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A pid file the fake engine writes, registered with the reaper before the engine exists. */
export function trackedPidFile(root: string, label: string): string {
  const pidFile = join(root, `${label}-${crypto.randomUUID()}.pid`);
  trackPidFile(pidFile);
  return pidFile;
}

/** Write a scenario for `FAKE_ENGINE_SCENARIO` and return its path. */
export async function writeScenario(root: string, steps: FakeEngineStep[]): Promise<string> {
  const path = join(root, `scenario-${crypto.randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ steps }));
  return path;
}

/** Every delta of a turn, in order; rejects as the turn's stream does. */
export async function drain(turn: {
  deltas: AsyncIterable<ExecutorDelta>;
}): Promise<ExecutorDelta[]> {
  const deltas: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) deltas.push(delta);
  return deltas;
}

/** Every delta of a turn, answering each `request` with approve as it arrives. */
export async function drainApproving(turn: {
  deltas: AsyncIterable<ExecutorDelta>;
  respond(interactionId: string, answer: { kind: 'approve' }): Promise<void>;
}): Promise<ExecutorDelta[]> {
  const deltas: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) {
    deltas.push(delta);
    if (delta.type === 'request') await turn.respond(delta.interactionId, { kind: 'approve' });
  }
  return deltas;
}

/** The JSON lines a fake engine recorded in `path`. */
export async function readJsonLines(path: string): Promise<unknown[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** The JSON lines a fake engine recorded in `path`; none while it has recorded nothing. */
export async function recordedLines(path: string): Promise<unknown[]> {
  return existsSync(path) ? readJsonLines(path) : [];
}

/**
 * The JSON lines a fake engine recorded in `path`, once one of them matches `wanted` — for an
 * answer the executor gives outside any turn, which no stream reports. Rejects, naming what it
 * waited for, when none matched within `timeoutMs`.
 */
export async function untilRecorded(
  path: string,
  wanted: (line: unknown) => boolean,
  timeoutMs = 5_000,
): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await recordedLines(path);
    if (lines.some(wanted)) return lines;
    if (Date.now() >= deadline)
      throw new Error(
        `No matching line in ${path} within ${timeoutMs} ms: ${JSON.stringify(lines)}`,
      );
    await Bun.sleep(20);
  }
}

/** A signal whose listeners are counted, so a test sees that every one added was removed. */
export function countedSignal(): {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  listeners(): number;
} {
  const controller = new AbortController();
  let active = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
    active += 1;
    return add(...args);
  };
  controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    active -= 1;
    return remove(...args);
  };
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    listeners: () => active,
  };
}
