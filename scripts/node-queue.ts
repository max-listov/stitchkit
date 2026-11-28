/**
 * Optional admission wrapper for a shared host node queue (`devkit run`).
 *
 * Delegates heavy Stitchkit scripts through `devkit run` when a compatible binary is on `PATH`,
 * publishing declarative `run-step-plan/v1` step plans via `--plan -` when supported so host
 * monitors display step-by-step progress and ETA. Runs directly when `devkit` is absent or
 * incompatible, when `STITCHKIT_NODE_QUEUE=0`, or when already inside a queued command
 * (`STITCHKIT_NODE_QUEUE_ACTIVE=1`).
 */
import { z } from 'zod';

export const NODE_QUEUE_ACTIVE_ENV = 'STITCHKIT_NODE_QUEUE_ACTIVE';
export const NODE_QUEUE_DISABLE_ENV = 'STITCHKIT_NODE_QUEUE';
export const NODE_QUEUE_PROJECT = 'stitchkit';

const HOST_QUEUE_BINARY = 'devkit';
const PROBE_TIMEOUT_MS = 3_000;
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
const USAGE =
  'Usage: node-queue.ts --label <label> [--kind <quality|gate|verify|release|build|test|acceptance>] [--project <name>] (--step "<name>::<cmd> [args...]"... | -- <command> [args...])';

export const NodeQueueKindSchema = z.enum([
  'quality',
  'gate',
  'verify',
  'release',
  'build',
  'test',
  'acceptance',
]);
export type NodeQueueKind = z.infer<typeof NodeQueueKindSchema>;

export const NodeQueueStepSchema = z.strictObject({
  name: z.string().min(1).max(200),
  argv: z.tuple([z.string().min(1)]).rest(z.string()),
  cwd: z.string().min(1).optional(),
});
export type NodeQueueStep = z.infer<typeof NodeQueueStepSchema>;

export const NodeQueueStepPlanSchema = z.strictObject({
  schema: z.literal('run-step-plan/v1'),
  steps: z.array(NodeQueueStepSchema).min(1),
});
export type NodeQueueStepPlan = z.infer<typeof NodeQueueStepPlanSchema>;

export interface HostNodeQueueCapabilities {
  readonly supported: boolean;
  readonly supportsPlan: boolean;
}

export interface NodeQueueTarget {
  readonly label: string;
  readonly kind?: NodeQueueKind;
  readonly project?: string;
}

export interface NodeQueuePlanInput extends NodeQueueTarget {
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly which?: (binary: string) => string | null;
  readonly probe?: (binaryPath: string) => boolean;
}

export interface NodeQueueStepsInput extends NodeQueueTarget {
  readonly steps: readonly NodeQueueStep[];
  readonly fallbackCommand?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly which?: (binary: string) => string | null;
  readonly probe?: (binaryPath: string) => HostNodeQueueCapabilities;
}

export type NodeQueuePlan =
  | { readonly mode: 'direct' }
  | {
      readonly mode: 'queued';
      readonly argv: readonly string[];
      readonly env: Readonly<Record<string, string | undefined>>;
    };

export type NodeQueueStepsExecution =
  | { readonly mode: 'direct-steps'; readonly steps: readonly NodeQueueStep[] }
  | {
      readonly mode: 'queued-plan';
      readonly argv: readonly string[];
      readonly plan: NodeQueueStepPlan;
      readonly env: Readonly<Record<string, string | undefined>>;
    }
  | {
      readonly mode: 'queued';
      readonly argv: readonly string[];
      readonly env: Readonly<Record<string, string | undefined>>;
    };

export interface ReexecNodeQueueOptions extends NodeQueueTarget {
  readonly argv?: readonly string[];
}

export type ParsedNodeQueueArgs =
  | (NodeQueueTarget & { readonly command: readonly string[]; readonly steps?: undefined })
  | (NodeQueueTarget & {
      readonly steps: readonly NodeQueueStep[];
      readonly command?: undefined;
    });

/** Probes `binaryPath` for `run --label ... --project ...` and optional `--plan` support. */
export function probeHostNodeQueue(binaryPath: string): HostNodeQueueCapabilities {
  try {
    const result = Bun.spawnSync([binaryPath, 'run', '--help'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (result.exitCode !== 0) return { supported: false, supportsPlan: false };
    const decode = new TextDecoder();
    const help = `${decode.decode(result.stdout)}\n${decode.decode(result.stderr)}`;
    const supported = help.includes('--label') && help.includes('--project');
    return { supported, supportsPlan: supported && help.includes('--plan') };
  } catch {
    return { supported: false, supportsPlan: false };
  }
}

/** Verifies that `binaryPath` implements the `run --label ... --project ...` queue protocol. */
export function supportsHostNodeQueue(binaryPath: string): boolean {
  return probeHostNodeQueue(binaryPath).supported;
}

function queuePrefix(
  binaryPath: string,
  target: NodeQueueTarget,
  project: string,
): readonly string[] {
  return [
    binaryPath,
    'run',
    '--label',
    target.label,
    '--project',
    project,
    ...(target.kind !== undefined ? ['--kind', target.kind] : []),
  ];
}

function resolveTarget(target: NodeQueueTarget): string {
  if (target.label.trim().length === 0) throw new Error('node-queue: label must be non-empty');
  const project = (target.project ?? NODE_QUEUE_PROJECT).trim();
  if (project.length === 0) throw new Error('node-queue: project must be non-empty');
  return project;
}

/** Purely decides whether to run directly or delegate through `devkit run`. */
export function planNodeQueueExecution(input: NodeQueuePlanInput): NodeQueuePlan {
  const project = resolveTarget(input);
  if (input.command.length === 0) throw new Error('node-queue: command must not be empty');
  const env = input.env ?? process.env;
  const bypassed = env[NODE_QUEUE_ACTIVE_ENV] === '1' || env[NODE_QUEUE_DISABLE_ENV] === '0';
  if (bypassed) return { mode: 'direct' };
  const lookup =
    input.which ?? ((binary: string) => Bun.which(binary, { PATH: env.PATH ?? '' }));
  const binaryPath = lookup(HOST_QUEUE_BINARY);
  const probe = input.probe ?? supportsHostNodeQueue;
  if (!binaryPath || !probe(binaryPath)) return { mode: 'direct' };
  return {
    mode: 'queued',
    argv: [...queuePrefix(binaryPath, input, project), '--', ...input.command],
    env: { ...env, [NODE_QUEUE_ACTIVE_ENV]: '1' },
  };
}

/**
 * Purely decides whether to run a step plan via `devkit run --plan -`, fall back to single-command
 * `devkit run -- <fallbackCommand>` on older host binaries, or execute the steps locally.
 */
export function planNodeQueueStepsExecution(
  input: NodeQueueStepsInput,
): NodeQueueStepsExecution {
  const project = resolveTarget(input);
  const plan = NodeQueueStepPlanSchema.parse({
    schema: 'run-step-plan/v1',
    steps: input.steps,
  });
  const env = input.env ?? process.env;
  const bypassed = env[NODE_QUEUE_ACTIVE_ENV] === '1' || env[NODE_QUEUE_DISABLE_ENV] === '0';
  if (bypassed) return { mode: 'direct-steps', steps: plan.steps };
  const lookup =
    input.which ?? ((binary: string) => Bun.which(binary, { PATH: env.PATH ?? '' }));
  const binaryPath = lookup(HOST_QUEUE_BINARY);
  if (!binaryPath) return { mode: 'direct-steps', steps: plan.steps };
  const capabilities = (input.probe ?? probeHostNodeQueue)(binaryPath);
  if (!capabilities.supported) return { mode: 'direct-steps', steps: plan.steps };
  const childEnv = { ...env, [NODE_QUEUE_ACTIVE_ENV]: '1' };
  if (capabilities.supportsPlan) {
    return {
      mode: 'queued-plan',
      argv: [...queuePrefix(binaryPath, input, project), '--plan', '-'],
      plan,
      env: childEnv,
    };
  }
  if (input.fallbackCommand && input.fallbackCommand.length > 0) {
    return {
      mode: 'queued',
      argv: [...queuePrefix(binaryPath, input, project), '--', ...input.fallbackCommand],
      env: childEnv,
    };
  }
  return { mode: 'direct-steps', steps: plan.steps };
}

async function runWithForwardedSignals(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly stdinText?: string; readonly cwd?: string } = {},
): Promise<number> {
  const child = Bun.spawn([...argv], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stdin:
      options.stdinText !== undefined
        ? new TextEncoder().encode(options.stdinText)
        : 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...env },
  });
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const listener = () => {
      try {
        child.kill(signal);
      } catch {
        // Child may already have exited before the forwarded signal arrived.
      }
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  try {
    const exitCode = await child.exited;
    return child.signalCode === 'SIGINT'
      ? 130
      : child.signalCode === 'SIGTERM'
        ? 143
        : exitCode;
  } finally {
    for (const { signal, listener } of handlers) process.off(signal, listener);
  }
}

/**
 * Re-executes the current script (or explicit `argv`) inside the host node queue when available.
 * Returns the child exit code when delegated, or `undefined` to continue running locally.
 */
export async function reexecInNodeQueueIfAvailable(
  options: ReexecNodeQueueOptions,
): Promise<number | undefined> {
  const plan = planNodeQueueExecution({
    ...options,
    command: options.argv ?? [process.execPath, ...process.argv.slice(1)],
    env: process.env,
  });
  return plan.mode === 'queued' ? runWithForwardedSignals(plan.argv, plan.env) : undefined;
}

/**
 * Executes a planned sequence of steps through `devkit run --plan -` when available, falling back
 * to single-command queueing on older host binaries or sequential local execution without `devkit`.
 */
export async function executeNodeQueueStepsPlan(
  execution: NodeQueueStepsExecution,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  if (execution.mode === 'queued-plan') {
    return runWithForwardedSignals(execution.argv, execution.env, {
      stdinText: `${JSON.stringify(execution.plan)}\n`,
    });
  }
  if (execution.mode === 'queued') {
    return runWithForwardedSignals(execution.argv, execution.env);
  }
  for (const step of execution.steps) {
    const code = await runWithForwardedSignals(step.argv, env, {
      ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
    });
    if (code !== 0) return code;
  }
  return 0;
}

function tokenizeStepCommand(command: string, rawSpec: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? '';
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\') {
        const next = command[i + 1];
        if (next === undefined) {
          throw new Error(`${USAGE} (unterminated escape in --step: ${rawSpec})`);
        }
        if (next === '"' || next === '\\') {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === '\\') {
      const next = command[i + 1];
      if (next === undefined) {
        throw new Error(`${USAGE} (trailing backslash in --step: ${rawSpec})`);
      }
      current += next;
      hasToken = true;
      i += 1;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote !== null) {
    throw new Error(`${USAGE} (unterminated ${quote} quote in --step: ${rawSpec})`);
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Parses one `--step "<name>::<cmd> [args...]"` specification into a validated `NodeQueueStep`. */
export function parseNodeQueueStepSpec(raw: string): NodeQueueStep {
  const separator = raw.indexOf('::');
  if (separator === -1)
    throw new Error(`${USAGE} (expected --step "<name>::<cmd> [args...]", got: ${raw})`);
  const name = raw.slice(0, separator).trim();
  const tokens = tokenizeStepCommand(raw.slice(separator + 2), raw);
  const [head, ...rest] = tokens;
  if (name.length === 0 || head === undefined || head.length === 0)
    throw new Error(`${USAGE} (invalid --step value: ${raw})`);
  return NodeQueueStepSchema.parse({ name, argv: [head, ...rest] });
}

/** Parses CLI options for either `--step ...` plan mode or `-- <command>` single-command mode. */
export function parseNodeQueueArgs(argv: readonly string[]): ParsedNodeQueueArgs {
  let label = '';
  let kind: NodeQueueKind | undefined;
  let project: string | undefined;
  const steps: NodeQueueStep[] = [];
  let command: readonly string[] | undefined;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    if (token === '--') {
      command = argv.slice(index + 1);
      break;
    }
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (flag !== '--label' && flag !== '--kind' && flag !== '--project' && flag !== '--step')
      throw new Error(`${USAGE} (unexpected argument: ${token})`);
    const value = eq === -1 ? argv[index + 1] : token.slice(eq + 1);
    if (value === undefined || (eq === -1 && value === '--'))
      throw new Error(`${USAGE} (missing value for ${flag})`);
    index += eq === -1 ? 2 : 1;
    if (flag === '--label') label = value;
    else if (flag === '--project') project = value;
    else if (flag === '--step') steps.push(parseNodeQueueStepSpec(value));
    else {
      const parsed = NodeQueueKindSchema.safeParse(value);
      if (!parsed.success) throw new Error(`${USAGE} (invalid --kind: ${value})`);
      kind = parsed.data;
    }
  }
  if (label.trim().length === 0) throw new Error(USAGE);
  const target: NodeQueueTarget = {
    label,
    ...(kind !== undefined ? { kind } : {}),
    ...(project !== undefined ? { project } : {}),
  };
  if (steps.length > 0 && command !== undefined)
    throw new Error(`${USAGE} (--step and -- are mutually exclusive)`);
  if (steps.length > 0) return { ...target, steps };
  if (command === undefined || command.length === 0) throw new Error(USAGE);
  return { ...target, command };
}

if (import.meta.main) {
  const parsed = parseNodeQueueArgs(process.argv.slice(2));
  if (parsed.steps !== undefined) {
    const execution = planNodeQueueStepsExecution({
      label: parsed.label,
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      ...(parsed.project !== undefined ? { project: parsed.project } : {}),
      steps: parsed.steps,
      fallbackCommand: [process.execPath, ...process.argv.slice(1)],
      env: process.env,
    });
    process.exit(await executeNodeQueueStepsPlan(execution, process.env));
  }
  const plan = planNodeQueueExecution({ ...parsed, env: process.env });
  const [argv, env] =
    plan.mode === 'queued' ? [plan.argv, plan.env] : [parsed.command, process.env];
  process.exit(await runWithForwardedSignals(argv, env));
}
