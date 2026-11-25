import { z } from 'zod';
import { type FakeEngineScenario, FakeEngineScenarioSchema } from './fake-engine';

/** What a Claude Code engine reads from its `stream-json` input: a record type, and a control subtype. */
const ClaudeInputRecordSchema = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  request: z.looseObject({ subtype: z.string() }).optional(),
  response: z.looseObject({ subtype: z.string() }).optional(),
});

/**
 * Play a scenario as Claude Code does on `stream-json`: the engine side of a
 * Claude-dialect conformance test. An `expect` step matches a record's `type`
 * and its `request`/`response` `subtype`; a `user` record's `uuid` is the input
 * the engine took (`onInput`, its transcript). `lines` is what the executor
 * wrote; `write` answers; `exit` ends the process with a code, `crash` without
 * flushing a word. Codex and ACP speak JSON-RPC and are played by their own fakes.
 */
export async function runFakeClaudeEngine(input: {
  scenario: FakeEngineScenario;
  lines: AsyncIterator<string>;
  write(line: string): void;
  onInput(uuid: string): Promise<void> | void;
  exit(code: number): never;
  crash(): never;
}): Promise<void> {
  const scenario = FakeEngineScenarioSchema.parse(input.scenario);
  for (const step of scenario.steps) {
    switch (step.do) {
      case 'expect': {
        for (;;) {
          const next = await input.lines.next();
          if (next.done) input.exit(0);
          const record = ClaudeInputRecordSchema.parse(JSON.parse(next.value));
          if (record.type === 'user' && record.uuid !== undefined && scenario.keepTranscript) {
            await input.onInput(record.uuid);
          }
          const subtype = record.request?.subtype ?? record.response?.subtype;
          if (
            record.type === step.type &&
            (step.subtype === undefined || step.subtype === subtype)
          )
            break;
        }
        break;
      }
      case 'emit':
        input.write(JSON.stringify(step.record));
        break;
      case 'emit-raw':
        input.write(step.line);
        break;
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        break;
      case 'crash':
        input.crash();
        break;
      case 'exit':
        input.exit(step.code);
        break;
    }
  }
  // Played to the end: wait for the executor to close the input, as an engine idles.
  for (;;) {
    const next = await input.lines.next();
    if (next.done) input.exit(0);
  }
}
