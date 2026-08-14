/**
 * The smallest real consumer: `stitchkit` + `zod`, no optional peer installed.
 *
 * Two jobs, and both are things the in-repo suite structurally cannot do.
 *
 * 1. **Name the types.** Every annotation below is deliberate. A type that is
 *    used inside the package but not exported from an entrypoint compiles fine
 *    in `src` and fails right here — that is how `ToolCallContext` reached 0.30
 *    unexported.
 * 2. **Exercise the built artifact.** The log format is decided by code that a
 *    bundler can constant-fold; reading it from `dist`, at run time, is the only
 *    check that means anything. It was frozen to a literal in every published
 *    copy for the project's whole life and no source test could see it.
 */
import { AppError, defineContract, type RuntimeContext } from 'stitchkit/contract';
import {
  getTraceId,
  type RequestEvent,
  setRequestError,
  wrapInRequestContext,
} from 'stitchkit/observability';
import {
  createHandler,
  implement,
  implementRegistry,
  type LifecycleHooks,
  type LogFormat,
  type LoggingConfig,
  type MethodDef,
  type StitchLogger,
} from 'stitchkit/server';
import { createHandlerTestClient } from 'stitchkit/testing';
import { z } from 'zod';

// Declared locally on purpose. The fixture runs with `types: []` so that the
// only ambient types in play are the ones the package itself drags in — if
// `stitchkit` ever needs `@types/node` or `@types/bun` to be usable, that must
// show up as a failure here rather than be hidden by the fixture's own tsconfig.
declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown): void {
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${what}`, detail === undefined ? '' : detail);
}

// ── the contract, as a consumer writes it ────────────────────────────────────

const widgets = defineContract(
  { prefix: 'widgets' },
  {
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get a widget',
      params: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
    },
    complete: {
      method: 'POST',
      path: '/complete',
      desc: 'Complete a typed HTTP operation',
      output: z.object({ id: z.string() }),
      responseMeta: { status: 201 },
    },
  },
);

const service = implement(widgets, {
  get: (ctx) => {
    if (ctx.params.id === 'boom') throw new AppError('NOT_FOUND', 'No such widget', 404);
    return { id: ctx.params.id };
  },
  complete: ({ req, response }) => {
    const request: Request = req;
    response.headers.append('Set-Cookie', 'fixture=ok; Path=/');
    void request;
    return { id: 'complete' };
  },
});

const registryServices = implementRegistry(
  { widgets },
  {
    widgets: {
      get: ({ params }) => ({ id: params.id }),
      complete: () => ({ id: 'complete' }),
    },
  },
);
check(
  'the packed implementation registry binds every declared contract',
  registryServices.length === 1 && registryServices[0]?.name === 'widgets',
);

if (process.env.STITCHKIT_COMPILE_REMOVED_API) {
  // @ts-expect-error every registry contract requires a handlers entry
  implementRegistry({ widgets }, {});
  implementRegistry(
    { widgets },
    {
      widgets: {
        get: ({ params }) => ({ id: params.id }),
        complete: () => ({ id: 'complete' }),
      },
      // @ts-expect-error handlers cannot add a contract absent from the registry
      extra: {},
    },
  );
  implementRegistry(
    { widgets },
    {
      // @ts-expect-error every contract endpoint requires an implementation
      widgets: {},
    },
  );
  implementRegistry(
    { widgets },
    {
      widgets: {
        get: ({ params }) => ({ id: params.id }),
        complete: () => ({ id: 'complete' }),
        // @ts-expect-error contract does not declare an extra endpoint handler
        extra: () => undefined,
      },
    },
  );
  implementRegistry(
    { widgets },
    {
      widgets: {
        // @ts-expect-error endpoint output must match its contract schema
        get: ({ params }) => ({ wrong: params.id }),
        complete: () => ({ id: 'complete' }),
      },
    },
  );
}

// ── types a consumer is required to name ─────────────────────────────────────
// Each of these is a public signature's type. If one stops being exported this
// file stops compiling, which is the entire point.

const format: LogFormat = 'json';
const logging: LoggingConfig = { format, enrich: () => ({ app: 'fixture' }) };
const sink: StitchLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
void sink;
const hooks: LifecycleHooks = {
  beforeHandle: (_ctx: RuntimeContext, _endpoint: MethodDef) => undefined,
  onError: (_ctx, error) => {
    setRequestError({ message: error instanceof Error ? error.message : String(error) });
    return undefined;
  },
};
const event: Partial<RequestEvent> = { method: 'GET' };
void event;

// ── run it, and read what the built package actually printed ─────────────────

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  function restore(): void {
    console.log = original;
  }
  return { lines, restore };
}

async function callWith(logConfig: LoggingConfig, path: string): Promise<string[]> {
  const handler = createHandler({
    services: [service],
    logging: logConfig,
    hooks,
    traceId: getTraceId,
  });
  const fetchIt = wrapInRequestContext(handler);
  const { lines, restore } = capture();
  try {
    await fetchIt(new Request(`http://localhost${path}`), undefined);
  } finally {
    restore();
  }
  return lines;
}

const testApi = createHandlerTestClient({
  contract: widgets,
  handler: createHandler({ services: registryServices }),
});
check(
  'the packed testing entrypoint runs a generated client through a real handler',
  (await testApi.get({ id: 'packed-test' })).id === 'packed-test',
);

const json = await callWith(logging, '/widgets/w1');
check('json format writes exactly one line', json.length === 1, json);
let parsed: Record<string, unknown> | undefined;
try {
  parsed = JSON.parse(json[0] ?? '');
} catch {
  parsed = undefined;
}
check(
  'the line is JSON — the structured branch is reachable from dist',
  parsed !== undefined,
  json[0],
);
check('it carries the request', parsed?.path === '/widgets/w1', parsed);

const enriched = await callWith(
  { format: 'json', enrich: () => ({ app: 'fixture' }) },
  '/widgets/w1',
);
check('enrich reaches the line', (enriched[0] ?? '').includes('"app":"fixture"'), enriched[0]);

const pretty = await callWith({ format: 'pretty' }, '/widgets/w1');
check('pretty writes two lines', pretty.length === 2, pretty);

// The default follows the environment, read per request rather than frozen at
// this package's build. Mutating it between calls is the whole assertion.
const runtimeEnv: Record<string, string | undefined> = process.env;
const before = runtimeEnv.NODE_ENV;
runtimeEnv.NODE_ENV = 'production';
const prodDefault = await callWith({}, '/widgets/w1');
runtimeEnv.NODE_ENV = 'development';
const devDefault = await callWith({}, '/widgets/w1');
runtimeEnv.NODE_ENV = before;

check(
  'NODE_ENV=production defaults to one structured line',
  prodDefault.length === 1,
  prodDefault,
);
check('development defaults to two pretty lines', devDefault.length === 2, devDefault);
check(
  'the environment is read at run time, not folded at build time',
  prodDefault.length !== devDefault.length,
  { prodDefault, devDefault },
);

// A failure still produces a row, and the code reaches it.
const failed = await callWith({ format: 'json' }, '/widgets/boom');
check('a failed request logs its code', (failed[0] ?? '').includes('NOT_FOUND'), failed[0]);

if (failures > 0) {
  console.error(`minimal consumer: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('minimal consumer: ok');
