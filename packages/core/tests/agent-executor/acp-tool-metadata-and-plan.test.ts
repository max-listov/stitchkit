import { describe, expect, test } from 'bun:test';
import { type AcpUpdateTrack, mapAcpUpdate } from '../../src/agent-executor/acp/v1-map';
import {
  ExecutorDeltaSchema,
  ExecutorPlanDeltaSchema,
  projectExecutorDeltas,
} from '../../src/entrypoints/agent-executor';
import {
  AcpPlanEntrySchema,
  AcpSessionUpdateSchema,
  AcpToolLocationSchema,
} from '../../src/entrypoints/agent-executor/acp';

describe('ACP tool metadata, in_progress updates and plan deltas', () => {
  test('AcpSessionUpdateSchema types locations for tool_call/tool_call_update and entries for plan/plan_update', () => {
    const loc = AcpToolLocationSchema.parse({ path: 'src/app.ts', line: 42, column: 3 });
    expect(loc).toEqual({ path: 'src/app.ts', line: 42, column: 3 });

    // 0-indexed LSP/ACP tool locations (line: 0, column: 0) are accepted; negative or fractional coordinates are refused.
    const zeroLoc = AcpToolLocationSchema.parse({ path: 'src/app.ts', line: 0, column: 0 });
    expect(zeroLoc).toEqual({ path: 'src/app.ts', line: 0, column: 0 });
    expect(AcpToolLocationSchema.safeParse({ path: 'src/app.ts', line: -1 }).success).toBe(
      false,
    );
    expect(AcpToolLocationSchema.safeParse({ path: 'src/app.ts', column: -1 }).success).toBe(
      false,
    );
    expect(AcpToolLocationSchema.safeParse({ path: 'src/app.ts', line: 1.5 }).success).toBe(
      false,
    );

    const entry = AcpPlanEntrySchema.parse({
      content: 'Audit protocol schemas',
      status: 'in_progress',
      priority: 'high',
    });
    expect(entry).toMatchObject({ content: 'Audit protocol schemas', status: 'in_progress' });

    const toolUpdate = AcpSessionUpdateSchema.parse({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      name: 'edit_file',
      title: 'Edit src/app.ts',
      kind: 'edit',
      rawInput: { path: 'src/app.ts' },
      locations: [{ path: 'src/app.ts', line: 10 }],
    });
    expect(toolUpdate.locations).toEqual([{ path: 'src/app.ts', line: 10 }]);

    const planUpdate = AcpSessionUpdateSchema.parse({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Step 1', status: 'completed', priority: 'high' },
        { content: 'Step 2', status: 'in_progress' },
      ],
    });
    expect(planUpdate.entries).toHaveLength(2);
  });

  test('mapAcpUpdate preserves title, kind and locations alongside name and forwards in_progress updates with updated rawInput/locations', () => {
    const track: AcpUpdateTrack = { segment: 0, toolNames: new Map() };

    const initial = mapAcpUpdate(
      AcpSessionUpdateSchema.parse({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-42',
        name: 'read_file',
        title: 'Read package.json',
        kind: 'read',
        rawInput: { path: 'package.json' },
        locations: [{ path: 'package.json', line: 1 }],
      }),
      'turn-1',
      1,
      track,
    );
    expect(initial).toHaveLength(1);
    const first = ExecutorDeltaSchema.parse(initial[0]);
    expect(first).toMatchObject({
      type: 'tool-call',
      callId: 'tc-42',
      toolName: 'read_file',
      input: { path: 'package.json' },
      provider: {
        schemaVersion: 1,
        provider: 'acp',
        data: {
          title: 'Read package.json',
          kind: 'read',
          locations: [{ path: 'package.json', line: 1 }],
        },
      },
    });

    // Empty in_progress heartbeat carries no new input or metadata -> produces no noisy delta.
    expect(
      mapAcpUpdate(
        AcpSessionUpdateSchema.parse({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-42',
          status: 'in_progress',
        }),
        'turn-1',
        2,
        track,
      ),
    ).toEqual([]);

    // Meaningful in_progress update refines rawInput, title and locations without losing toolName.
    const progress = mapAcpUpdate(
      AcpSessionUpdateSchema.parse({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-42',
        status: 'in_progress',
        title: 'Read package.json lines 1-80',
        rawInput: { path: 'package.json', startLine: 1, endLine: 80 },
        locations: [
          { path: 'package.json', line: 1 },
          { path: 'package.json', line: 80 },
        ],
      }),
      'turn-1',
      3,
      track,
    );
    expect(progress).toHaveLength(1);
    const second = ExecutorDeltaSchema.parse(progress[0]);
    expect(second).toMatchObject({
      type: 'tool-call',
      itemId: 'call:tc-42',
      callId: 'tc-42',
      toolName: 'read_file',
      input: { path: 'package.json', startLine: 1, endLine: 80 },
      provider: {
        schemaVersion: 1,
        provider: 'acp',
        data: {
          title: 'Read package.json lines 1-80',
          kind: 'read',
          status: 'in_progress',
          locations: [
            { path: 'package.json', line: 1 },
            { path: 'package.json', line: 80 },
          ],
        },
      },
    });

    // Completion preserves toolName and carries final locations on tool-result when provided.
    const completed = mapAcpUpdate(
      AcpSessionUpdateSchema.parse({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-42',
        status: 'completed',
        rawOutput: { lines: 80 },
        locations: [{ path: 'package.json', line: 80 }],
      }),
      'turn-1',
      4,
      track,
    );
    expect(completed).toHaveLength(1);
    const third = ExecutorDeltaSchema.parse(completed[0]);
    expect(third).toMatchObject({
      type: 'tool-result',
      callId: 'tc-42',
      toolName: 'read_file',
      outcome: 'success',
      output: { lines: 80 },
      provider: {
        schemaVersion: 1,
        provider: 'acp',
        data: {
          title: 'Read package.json lines 1-80',
          kind: 'read',
          locations: [{ path: 'package.json', line: 80 }],
        },
      },
    });

    // Projection collapses in_progress tool-call replacement cleanly without duplicating tool calls.
    const parts = projectExecutorDeltas([...initial, ...progress, ...completed]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: 'tool-call',
      callId: 'tc-42',
      toolName: 'read_file',
      input: { path: 'package.json', startLine: 1, endLine: 80 },
    });
    expect(parts[1]).toMatchObject({
      type: 'tool-result',
      callId: 'tc-42',
      toolName: 'read_file',
      outcome: 'success',
    });
  });

  test('plan, plan_update and plan_removed map to typed ExecutorPlanDelta instead of QUIET', () => {
    const setDeltas = mapAcpUpdate(
      AcpSessionUpdateSchema.parse({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect schemas', status: 'completed', priority: 'high' },
          { content: 'Update mapper', status: 'in_progress', priority: 'medium' },
          {
            content: 'Vendor unknown status step',
            status: 'custom_vendor',
            priority: 'urgent',
          },
        ],
      }),
      'turn-1',
      1,
    );
    expect(setDeltas).toHaveLength(1);
    expect(ExecutorPlanDeltaSchema.parse(setDeltas[0])).toMatchObject({
      type: 'plan',
      itemId: 'plan',
      action: 'set',
      entries: [
        { content: 'Inspect schemas', status: 'completed', priority: 'high' },
        { content: 'Update mapper', status: 'in_progress', priority: 'medium' },
        { content: 'Vendor unknown status step' },
      ],
    });

    const updateDeltas = mapAcpUpdate(
      AcpSessionUpdateSchema.parse({
        sessionUpdate: 'plan_update',
        plan: {
          id: 'plan-7',
          entries: [{ content: 'Run tests', status: 'pending', priority: 'low' }],
        },
      }),
      'turn-1',
      2,
    );
    expect(updateDeltas).toHaveLength(1);
    expect(ExecutorPlanDeltaSchema.parse(updateDeltas[0])).toMatchObject({
      type: 'plan',
      itemId: 'plan:plan-7',
      action: 'update',
      planId: 'plan-7',
      entries: [{ content: 'Run tests', status: 'pending', priority: 'low' }],
    });

    const removedDeltas = mapAcpUpdate(
      AcpSessionUpdateSchema.parse({
        sessionUpdate: 'plan_removed',
        planId: 'plan-7',
      }),
      'turn-1',
      3,
    );
    expect(removedDeltas).toHaveLength(1);
    expect(ExecutorPlanDeltaSchema.parse(removedDeltas[0])).toMatchObject({
      type: 'plan',
      itemId: 'plan:plan-7',
      action: 'remove',
      planId: 'plan-7',
    });

    // Projection ignores plan lifecycle deltas so message parts remain unaffected.
    expect(projectExecutorDeltas([...setDeltas, ...updateDeltas, ...removedDeltas])).toEqual(
      [],
    );
  });
});
