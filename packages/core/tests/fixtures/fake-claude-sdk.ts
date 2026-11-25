/**
 * A scripted Agent SDK `query` for the SDK leaf's conformance: plays the same
 * Claude-dialect scenarios as the CLI fake, in process. A `can_use_tool`
 * record becomes a `canUseTool` call, as the SDK makes it; an interrupt is
 * `Query.interrupt()`; an invalid line is the parse error the SDK throws. Each answered
 * `canUseTool` call is kept in the profile's `permissions.jsonl`.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { claudeTranscriptPath } from '../../src/agent-executor/claude/transcript';
import type { ClaudeSdkQuery } from '../../src/agent-executor/claude-sdk/driver';
import {
  type FakeEngineScenario,
  FakeEngineScenarioSchema,
} from '../../src/agent-executor/testing/fake-engine';

const PermissionRecord = z.looseObject({
  type: z.literal('control_request'),
  request: z.looseObject({
    subtype: z.literal('can_use_tool'),
    tool_name: z.string(),
    tool_use_id: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
});

export function fakeClaudeQuery(
  raw: FakeEngineScenario,
  seen: (options: unknown) => void = () => undefined,
): ClaudeSdkQuery {
  const scenario = FakeEngineScenarioSchema.parse(raw);
  return ({ prompt, options }) => {
    seen(options);
    const input = prompt[Symbol.asyncIterator]();
    let interrupt = Promise.withResolvers<void>();
    let permission: Promise<unknown> = Promise.resolve();
    const configDir = options?.env?.CLAUDE_CONFIG_DIR;
    const home = configDir ?? '/nonexistent';
    const session = options?.sessionId ?? options?.resume ?? 'unknown';
    const transcript = claudeTranscriptPath({
      home,
      cwd: options?.cwd ?? '/',
      sessionId: session,
    });
    async function* run(): AsyncGenerator<unknown> {
      for (const step of scenario.steps) {
        if (step.do === 'expect' && step.type === 'user') {
          const next = await input.next();
          if (next.done) return;
          mkdirSync(dirname(transcript), { recursive: true });
          appendFileSync(
            transcript,
            `${JSON.stringify({ type: 'user', uuid: next.value.uuid })}\n`,
          );
        } else if (step.do === 'expect' && step.type === 'control_request') {
          await interrupt.promise;
          interrupt = Promise.withResolvers<void>();
        } else if (step.do === 'expect') {
          await permission;
        } else if (step.do === 'emit') {
          const asked = PermissionRecord.safeParse(step.record);
          if (asked.success && options?.canUseTool !== undefined) {
            const toolUseId = asked.data.request.tool_use_id;
            permission = options
              .canUseTool(asked.data.request.tool_name, asked.data.request.input, {
                signal: new AbortController().signal,
                toolUseID: toolUseId,
                requestId: crypto.randomUUID(),
              })
              .then((answer) => {
                // What the SDK was answered, kept where a test can read it, as the CLI fake keeps stdin.
                if (configDir !== undefined) {
                  mkdirSync(configDir, { recursive: true });
                  appendFileSync(
                    join(configDir, 'permissions.jsonl'),
                    `${JSON.stringify({ toolUseId, behavior: answer?.behavior })}\n`,
                  );
                }
                return answer;
              });
          } else {
            yield step.record;
          }
        } else if (step.do === 'emit-raw') {
          throw new SyntaxError(`Unexpected end of JSON input: ${step.line}`);
        } else if (step.do === 'delay') {
          await new Promise((resolve) => setTimeout(resolve, step.ms));
        } else if (step.do === 'crash') {
          throw new Error('Claude Code process exited with code 137');
        } else {
          return;
        }
      }
      while (!(await input.next()).done) {
        // Idle, as the engine does between turns, until the prompt ends.
      }
    }
    const records = run();
    return {
      [Symbol.asyncIterator]: () => records,
      interrupt: async () => {
        interrupt.resolve();
      },
      close() {
        // Nothing to release: the scripted query holds no process.
      },
    };
  };
}
