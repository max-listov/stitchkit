import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [root, mode] = process.argv.slice(2);
if (root === undefined || mode === undefined) {
  throw new Error('Usage: acp-close-liveness-peer.ts <root> <mode>');
}

writeFileSync(join(root, 'pid'), String(process.pid));

const write = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
};

const record = (file: string, entry: unknown): void => {
  appendFileSync(join(root, file), `${JSON.stringify(entry)}\n`);
};

const sendPermission = (id: string, title: string): void => {
  write({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 's-1',
      toolCall: { toolCallId: `tc-${id}`, title },
      options: [
        { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
      ],
    },
  });
};

const sendUpdate = (update: Record<string, unknown>): void => {
  write({
    method: 'session/update',
    params: { sessionId: 's-1', update },
  });
};

let pendingPromptId: string | number | undefined;
let exiting = false;

if (mode === 'abort-active' || mode === 'abort-external') {
  process.on('SIGTERM', () => {
    if (exiting) return;
    exiting = true;
    sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'late-after-abort' },
    });
    sendPermission('late-perm-after-abort', 'LateAfterAbort');
    writeFileSync(join(root, 'sigterm-received'), '1');
    setTimeout(() => process.exit(0), 80);
  });
}

if (mode === 'disconnect-active' || mode === 'disconnect-external') {
  const watcher = setInterval(() => {
    if (existsSync(join(root, 'trigger-exit'))) {
      clearInterval(watcher);
      process.exit(1);
    }
  }, 10);
  watcher.unref();
}

const waitForRelease = (flag: string, onRelease: () => void): void => {
  const deadline = Date.now() + 5_000;
  const poll = setInterval(() => {
    if (existsSync(join(root, flag)) || Date.now() >= deadline) {
      clearInterval(poll);
      onRelease();
    }
  }, 10);
  poll.unref();
};

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (line.trim().length === 0) continue;
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    record('responses.jsonl', msg);
    if (mode === 'live-positive' && msg.id === 'act-1' && pendingPromptId !== undefined) {
      const promptId = pendingPromptId;
      pendingPromptId = undefined;
      write({ id: promptId, result: { stopReason: 'end_turn' } });
      sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ext-live' },
      });
      sendPermission('ext-1', 'ExternalLive');
    }
    continue;
  }
  record('calls.jsonl', [msg.method, msg.id]);
  if (msg.method === 'initialize') {
    write({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        agentInfo: { name: 'liveness-peer', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'session/new') {
    sendUpdate({ sessionUpdate: 'session_info_update', title: 'initial' });
    sendUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'init-cmd' }],
    });
    write({ id: msg.id, result: { sessionId: 's-1' } });
  } else if (msg.method === 'session/prompt') {
    if (mode === 'live-positive') {
      pendingPromptId = msg.id;
      sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      });
      sendPermission('act-1', 'ActiveLive');
    } else if (
      mode === 'close-active' ||
      mode === 'disconnect-active' ||
      mode === 'abort-active'
    ) {
      pendingPromptId = msg.id;
      sendPermission('act-1', 'ActiveHeld');
    } else if (
      mode === 'close-external' ||
      mode === 'disconnect-external' ||
      mode === 'abort-external'
    ) {
      write({ id: msg.id, result: { stopReason: 'end_turn' } });
      sendPermission('ext-1', 'ExternalHeld');
    } else if (mode === 'abort-watch-outcome') {
      write({ id: msg.id, result: { stopReason: 'end_turn' } });
    }
  } else if (msg.method === 'session/close') {
    if (mode === 'close-active' || mode === 'close-external') {
      sendUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late-during-close' },
      });
      sendUpdate({ sessionUpdate: 'session_info_update', title: 'mutated-during-close' });
      sendUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'mutated-cmd' }],
      });
      sendPermission('late-perm-during-close', 'LateDuringClose');
      write({
        id: 'late-read-during-close',
        method: 'fs/read_text_file',
        params: { sessionId: 's-1', path: '/etc/hostname' },
      });
      writeFileSync(join(root, 'close-received'), '1');
      waitForRelease('release-close', () => {
        if (pendingPromptId !== undefined) {
          const promptId = pendingPromptId;
          pendingPromptId = undefined;
          write({ id: promptId, result: { stopReason: 'end_turn' } });
        }
        write({ id: msg.id, result: {} });
      });
    } else {
      write({ id: msg.id, result: {} });
    }
  }
}
