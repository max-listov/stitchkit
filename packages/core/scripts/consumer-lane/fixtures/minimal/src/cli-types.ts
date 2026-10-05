import {
  type CliConfig,
  type CliInvocationResult,
  type CliInvokerConfig,
  type CliRunOptions,
  cliInvocationResult,
  createCli,
  createCliInvoker,
  defineCliCommand,
  parseCliArgs,
  type RuntimeToolDefinition,
  type RuntimeToolDefinitionWithOutput,
  routeCliArgv,
} from 'stitchkit/cli';
import { writeFileAtomic } from 'stitchkit/files';
import { canonicalJson } from 'stitchkit/primitives';
import { observeProcessInstance } from 'stitchkit/process';
import { z } from 'zod';
import './cli-peer-absence.js';
import './cli-publish-leaf.js';

// Neutral declarations and CLI declarations use the same strict NodeNext program.
void writeFileAtomic;
void canonicalJson;
void observeProcessInstance;

const input = z.object({ text: z.string(), repeat: z.coerce.number().default(1) });
const output = z.object({ size: z.number() });
const command = defineCliCommand({
  name: 'measure',
  description: 'Measure repeated text',
  input,
  output,
  handler: ({ input, options, globals, stdout }) => {
    const count: number = input.repeat;
    const json: boolean = options.json;
    const applicationOptions: Readonly<Record<string, unknown>> = globals;
    void json;
    void applicationOptions;
    stdout('');
    // @ts-expect-error Parsed numeric fields remain numeric.
    const wrongInput: string = input.repeat;
    void wrongInput;
    return { size: input.text.length * count };
  },
  present: ({ result, options }) => `${result.size}:${options.json}`,
  exitCode: (result) => (result.size > 0 ? 0 : 1),
});
const validHandler: typeof command.handler = ({ input }) => ({ size: input.repeat });
// @ts-expect-error A declared numeric output rejects a string-returning handler.
const invalidHandler: typeof command.handler = () => ({ size: 'wrong' });
// @ts-expect-error A native command input rejects a number in a string field.
const invalidInput: Parameters<typeof command.handler>[0]['input'] = { text: 1, repeat: 2 };
// @ts-expect-error Presenters retain the inferred output schema.
const invalidPresenter: typeof command.present = ({ result }) => result.size;
void validHandler;
void invalidHandler;
void invalidInput;
void invalidPresenter;

const printing = defineCliCommand({
  name: 'print',
  description: 'Write directly',
  input: z.object({ text: z.string() }),
  handler: ({ input, stdout }) => stdout(input.text),
});
const globals = z.object({ account: z.string().default('local') });
const config: CliConfig<{ id: string }, { account: string }, typeof globals> = {
  name: 'strict-cli',
  version: '1.0.0',
  commands: [command, printing],
  globalOptions: globals,
  resolveAuth: (options) => ({ id: options.account }),
  context: (auth, options) => ({ account: auth?.id ?? options.account }),
  argv: ['measure', '--text', 'hello'],
};
const invokerConfig: CliInvokerConfig = {
  name: 'strict-invoker',
  commands: [command],
  runtimeTools: [
    {
      name: 'managed',
      description: 'A managed CLI operation',
      identity: { serviceName: 'probe', action: 'managed', method: 'POST' },
      transports: ['CLI'],
      input: z.object({ text: z.string() }),
      output,
      handler: () => ({ size: 1 }),
    },
  ],
};
const factoryConfig: CliInvokerConfig<{ id: string }> = {
  name: 'factory-invoker',
  commands: [command],
  auth: { id: 'local' },
  runtimeTools: () => [],
};
const managedInput = z.object({ text: z.string() });
const managed = {
  name: 'typed-managed',
  description: 'Strict neutral construction',
  identity: { serviceName: 'probe', action: 'managed', method: 'POST' },
  transports: ['CLI'],
  input: managedInput,
  output,
  handler: ({ input }) => ({ size: input.text.length }),
} satisfies RuntimeToolDefinitionWithOutput<typeof managedInput, typeof output>;
const extraInput = z.object({ text: z.string(), requiredExtra: z.string() });
const tooNarrow: RuntimeToolDefinitionWithOutput<typeof extraInput, typeof output>['handler'] =
  ({ input }) => ({ size: input.requiredExtra.length });
const invalidManaged: RuntimeToolDefinitionWithOutput<typeof managedInput, typeof output> = {
  ...managed,
  // @ts-expect-error Strict neutral construction rejects pretyped undeclared input fields.
  handler: tooNarrow,
};
void invalidManaged;
void createCliInvoker({ name: 'typed-neutral', runtimeTools: [managed] });
const registered: readonly RuntimeToolDefinition[] = [managed];
{
  const first = registered[0];
  if (first) {
    // @ts-expect-error A registered heterogeneous handler is called only after schema validation.
    first.handler({});
  }
}
void createCli(config);
void createCliInvoker(factoryConfig);
const invoker = await createCliInvoker(invokerConfig);
const result: CliInvocationResult = await invoker.invoke('measure', { text: 'hello' });
const validEnvelope: CliInvocationResult = { ok: true, exitCode: 0, data: { size: 5 } };
// @ts-expect-error Dynamic invocation data remains unknown until the caller validates it.
const dynamicData: string = result.data;
// @ts-expect-error Result exit codes remain numeric.
const invalidEnvelope: CliInvocationResult = { ok: true, exitCode: '0' };
const invalidError: CliInvocationResult = {
  ok: false,
  exitCode: 1,
  error: {
    code: 'BAD',
    // @ts-expect-error Error messages remain strings.
    message: 1,
  },
};
void validEnvelope;
void dynamicData;
void invalidEnvelope;
void invalidError;
const parsed = parseCliArgs(['--text', 'hello'], input);
const options: CliRunOptions = parsed.options;
const route = routeCliArgv(['measure', '--text', 'hello']);
const routed: string[] = route.commandArgv;
const normalized: CliInvocationResult = cliInvocationResult(
  { ok: true, data: 1 },
  'measure',
  {},
);
void options;
void routed;
void normalized;
