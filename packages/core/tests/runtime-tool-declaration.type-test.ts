/**
 * Compile-time contract of the one runtime-tool declaration.
 *
 * `bun test` does not pick this file up (no `.test.` segment); `tsc --noEmit`
 * (`bun run check`) does, so it asserts with types only.
 */
import { z } from 'zod';
import {
  type CliConfig,
  type CliInvokerConfig,
  createCliInvoker,
  type RuntimeToolDefinition,
  type RuntimeToolDefinitionWithOutput,
} from '../src/entrypoints/cli';
import { defineRuntimeTool, mountAgent } from '../src/entrypoints/tools';
import {
  buildMcpServer,
  type RuntimeToolDefinition as McpRegisteredTool,
  type RuntimeMcpToolPresenters,
} from '../src/entrypoints/tools/mcp';

const input = z.object({ text: z.string() });
const output = z.object({ size: z.number() });

// An inline handler in a registration list is contextually typed, not erased.
const inline: CliInvokerConfig = {
  name: 'inline',
  runtimeTools: [
    {
      name: 'inline_tool',
      description: 'Inline registration',
      identity: { serviceName: 'probe', action: 'inline', method: 'POST' },
      transports: ['CLI'],
      input,
      output,
      handler: ({ input: parsed, signal, source }) => {
        const keys: string[] = Object.keys(parsed);
        const aborted: boolean | undefined = signal?.aborted;
        void aborted;
        void source;
        // @ts-expect-error The parsed input is an object, never `never` or a bare string.
        const wrong: string = parsed;
        void wrong;
        return { size: keys.length };
      },
    },
  ],
};
void inline;

// An inline handler is typed in the other registration lists too.
const cliConfig: CliConfig = {
  name: 'cli',
  version: '1',
  runtimeTools: [
    {
      name: 'void_tool',
      description: 'No output',
      identity: { serviceName: 'probe', action: 'noop', method: 'POST' },
      transports: ['CLI'],
      input,
      handler: ({ input: parsed }) => {
        void Object.keys(parsed);
      },
    },
  ],
};
void cliConfig;
void mountAgent([], {
  runtimeTools: [
    {
      name: 'agent_inline',
      description: 'Inline Agent registration',
      identity: { serviceName: 'probe', action: 'agent', method: 'POST' },
      input,
      output,
      handler: ({ input: parsed }) => ({ size: Object.keys(parsed).length }),
    },
  ],
});
void buildMcpServer({
  serverInfo: { name: 'inline', version: '1' },
  services: [],
  runtimeTools: [
    {
      name: 'mcp_inline',
      description: 'Inline MCP registration',
      identity: { serviceName: 'probe', action: 'mcp', method: 'POST' },
      input,
      output,
      handler: ({ input: parsed }) => ({ size: Object.keys(parsed).length }),
    },
  ],
});

// A definition constructed against its own schema is typed exactly and registers.
const measured = {
  name: 'measure',
  description: 'Typed construction',
  identity: { serviceName: 'probe', action: 'measure', method: 'POST' },
  transports: ['CLI'],
  input,
  output,
  handler: ({ input: parsed }) => ({ size: parsed.text.length }),
} satisfies RuntimeToolDefinitionWithOutput<typeof input, typeof output>;
const registered: readonly RuntimeToolDefinition[] = [measured];
void createCliInvoker({ name: 'typed', runtimeTools: registered });

// Construction stays strict: a callback may not require a field the schema omits.
const wideInput = z.object({ text: z.string(), required: z.string() });
const tooNarrow: RuntimeToolDefinitionWithOutput<typeof wideInput, typeof output>['handler'] =
  ({ input: parsed }) => ({ size: parsed.required.length });
const refused: RuntimeToolDefinitionWithOutput<typeof input, typeof output> = {
  ...measured,
  // @ts-expect-error A pretyped handler needing an undeclared field is refused at construction.
  handler: tooNarrow,
};
void refused;

// The presenters are the adapter's extension of the one declaration.
const presented = defineRuntimeTool({
  ...measured,
  present: {
    mcp: ({ size }) => ({ content: [{ type: 'text', text: String(size) }] }),
    agent: ({ size }) => ({ type: 'text', value: String(size) }),
  },
});
const asRegistered: McpRegisteredTool = presented;
const asMcpPresented: RuntimeToolDefinitionWithOutput<
  typeof input,
  typeof output,
  undefined,
  RuntimeMcpToolPresenters<z.output<typeof output>>
> = presented;
void asRegistered;
void asMcpPresented;
const neutralWithPresenter: RuntimeToolDefinitionWithOutput<typeof input, typeof output> = {
  ...measured,
  // @ts-expect-error The neutral declaration carries no presenters unless an adapter names them.
  present: { mcp: () => ({ content: [] }) },
};
void neutralWithPresenter;

// A registered handler is not callable without the context the runner builds.
const first = registered[0];
if (first) {
  // @ts-expect-error The registered handler needs the runner's call context.
  first.handler({ input: { text: 'x' } });
}
