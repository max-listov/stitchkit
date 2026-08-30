import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DiagnosticJournalFrameSchema } from 'stitchkit/application';
import {
  AgentTuiDiagnosticEventSchema,
  createAgentTuiDiagnosticRecorder,
  projectAgentTuiRuntimeDiagnostic,
} from '../src/diagnostics';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Agent TUI diagnostics', () => {
  test('projects runtime transitions without text, tool input or internal causes', () => {
    const projected = projectAgentTuiRuntimeDiagnostic(
      {
        conversationId: 'conversation-1',
        runId: 'run-1',
        event: {
          type: 'terminal',
          state: 'failed',
          text: 'private model output',
          input: { path: 'private.txt' },
          internalCause: 'provider secret',
        },
      },
      '2026-08-30T00:00:00.000Z',
    );
    expect(projected).toEqual({
      schemaVersion: 1,
      occurredAt: '2026-08-30T00:00:00.000Z',
      type: 'runtime-event',
      conversationId: 'conversation-1',
      runId: 'run-1',
      eventType: 'terminal',
      state: 'failed',
    });
    expect(JSON.stringify(projected)).not.toContain('private');
    expect(projectAgentTuiRuntimeDiagnostic({ type: 'assistant-delta', text: 'secret' })).toBe(
      undefined,
    );
  });

  test('writes a bounded schema-validated lifecycle journal per terminal session', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'stitchkit-tui-diagnostics-'));
    temporaryDirectories.push(workspace);
    const sessionId = '1234567890abcdef';
    const recorder = await createAgentTuiDiagnosticRecorder({ workspace, sessionId });
    recorder.record({
      schemaVersion: 1,
      occurredAt: '2026-08-30T00:00:00.000Z',
      type: 'host-started',
      sessionId,
      conversationId: 'conversation-1',
      launchMode: 'fresh',
    });
    await recorder.close();

    const filename = path.join(workspace, '.stitchkit', 'logs', 'tui', `${sessionId}.jsonl`);
    const [line] = (await Bun.file(filename).text()).trim().split('\n');
    const frame = DiagnosticJournalFrameSchema.parse(JSON.parse(line ?? ''));
    expect(AgentTuiDiagnosticEventSchema.parse(frame.event)).toMatchObject({
      type: 'host-started',
      sessionId,
      conversationId: 'conversation-1',
      launchMode: 'fresh',
    });
  });
});
