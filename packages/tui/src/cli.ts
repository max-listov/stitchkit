#!/usr/bin/env bun
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentTuiConfig } from './config';
import { runAgentTui } from './run';
import {
  type AgentTuiSessionRequest,
  createAgentTuiClient,
  listAgentTuiSessions,
} from './session';

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

async function request(sessionId: string, payload: AgentTuiSessionRequest): Promise<void> {
  const client = await createAgentTuiClient({
    rootDirectory: path.resolve(argument('--workspace') ?? process.cwd()),
    sessionId,
  });
  const response = await client.request(payload);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (response.outcome === 'error') process.exitCode = 1;
}

async function loadConfig(filename: string): Promise<unknown> {
  const module = await import(pathToFileURL(path.resolve(filename)).href);
  return Reflect.get(module, 'default');
}

function isAgentTuiConfig(value: unknown): value is AgentTuiConfig<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'createRuntime') === 'function' &&
    typeof Reflect.get(value, 'context') === 'function' &&
    typeof Reflect.get(value, 'modelCatalog') === 'object'
  );
}

const command = Bun.argv[2] ?? 'run';
if (command === 'sessions') {
  for (const session of await listAgentTuiSessions(
    path.resolve(argument('--workspace') ?? process.cwd()),
  )) {
    process.stdout.write(
      `${session.sessionId}\t${session.conversationId}\tpid=${session.pid}\n`,
    );
  }
} else if (command === 'status') {
  const sessionId = argument('--session');
  if (!sessionId) throw new Error('--session is required');
  await request(sessionId, { requestId: crypto.randomUUID(), operation: 'status' });
} else if (command === 'send') {
  const sessionId = argument('--session');
  const separator = Bun.argv.indexOf('--');
  const text =
    separator < 0
      ? undefined
      : Bun.argv
          .slice(separator + 1)
          .join(' ')
          .trim();
  if (!sessionId || !text)
    throw new Error('Usage: stitchkit-agent send --session ID -- message');
  await request(sessionId, {
    requestId: crypto.randomUUID(),
    operation: 'submit',
    text,
    idempotencyKey: argument('--idempotency-key') ?? crypto.randomUUID(),
  });
} else if (command === 'interrupt') {
  const sessionId = argument('--session');
  const runId = argument('--run');
  if (!sessionId) throw new Error('--session is required');
  await request(sessionId, {
    requestId: crypto.randomUUID(),
    operation: 'interrupt',
    ...(runId && { runId }),
  });
} else if (command === 'run') {
  const config = await loadConfig(argument('--config') ?? 'stitchkit.agent.ts');
  if (!isAgentTuiConfig(config)) {
    throw new Error('The config default export must be created with defineAgentTui()');
  }
  // Dynamic config loading is an intentional untyped module boundary. The
  // callable surface is checked above; consumer generics stay in the config.
  await runAgentTui(config);
} else {
  throw new Error(`Unknown command: ${command}`);
}
