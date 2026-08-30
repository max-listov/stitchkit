import { describe, expect, test } from 'bun:test';
import { AgentSnapshotSchema } from 'stitchkit/agent-runtime';
import { projectAgentTuiTranscript } from '../src/transcript';

describe('Agent TUI transcript projection', () => {
  test('renders a canonical error envelope as failure even when transport succeeded', () => {
    const at = '2026-08-30T00:00:00.000Z';
    const snapshot = AgentSnapshotSchema.parse({
      schemaVersion: 1,
      conversationId: 'main',
      version: 1,
      runs: [],
      messages: [
        {
          schemaVersion: 1,
          id: 'tool-message',
          conversationId: 'main',
          role: 'tool',
          status: 'completed',
          createdAt: at,
          updatedAt: at,
          parts: [
            {
              type: 'tool-result',
              callId: 'call-1',
              toolName: 'search_files',
              outcome: 'success',
              output: { error: 'INTERNAL_SERVER_ERROR' },
            },
          ],
        },
      ],
    });
    expect(projectAgentTuiTranscript(snapshot)[0]).toMatchObject({
      tone: 'danger',
      text: '× search_files {"error":"INTERNAL_SERVER_ERROR"}',
    });
  });

  test('keeps multimodal files visible and bounds long tool output', () => {
    const at = '2026-08-30T00:00:00.000Z';
    const snapshot = AgentSnapshotSchema.parse({
      schemaVersion: 1,
      conversationId: 'main',
      version: 1,
      runs: [],
      messages: [
        {
          schemaVersion: 1,
          id: 'assistant-message',
          conversationId: 'main',
          role: 'assistant',
          status: 'completed',
          createdAt: at,
          updatedAt: at,
          parts: [
            {
              type: 'file',
              reference: 'artifact://generated-preview',
              filename: 'preview.png',
              mediaType: 'image/png',
            },
            {
              type: 'tool-result',
              callId: 'call-2',
              toolName: 'read_output',
              outcome: 'success',
              output: { text: 'x'.repeat(1_000) },
            },
          ],
        },
      ],
    });
    const transcript = projectAgentTuiTranscript(snapshot);
    expect(transcript[0]?.text).toBe('File · preview.png');
    expect(transcript[1]?.text.startsWith('✓ read_output ')).toBe(true);
    expect(transcript[1]?.text.endsWith('…')).toBe(true);
    expect(transcript[1]?.text.length).toBeLessThan(390);
  });
});
