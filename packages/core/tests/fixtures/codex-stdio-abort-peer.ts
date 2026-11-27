import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [root, mode] = process.argv.slice(2);
if (root === undefined || mode === undefined) {
  throw new Error('Usage: codex-stdio-abort-peer.ts <root> <mode>');
}

writeFileSync(join(root, 'pid'), String(process.pid));

const write = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
};

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

let sigtermHandled = false;
if (mode === 'abort-observer') {
  process.on('SIGTERM', () => {
    if (sigtermHandled) return;
    sigtermHandled = true;
    writeFileSync(join(root, 'sigterm-received'), '1');
    waitForRelease('release-exit', () => process.exit(0));
  });
}

let threadCounter = 0;
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (line.trim().length === 0) continue;
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    appendFileSync(join(root, 'responses.jsonl'), `${line}\n`);
    continue;
  }
  appendFileSync(
    join(root, 'calls.jsonl'),
    `${JSON.stringify([msg.method, msg.params ?? null])}\n`,
  );
  if (msg.method === 'initialize') {
    write({ id: msg.id, result: { userAgent: 'codex-stdio-abort-peer/1.0' } });
    if (mode === 'control-abort') {
      write({
        id: 'ctl-abort-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-ctl',
          turnId: 'turn-ctl',
          itemId: 'cmd-ctl',
          command: 'echo ctl',
        },
      });
    }
  } else if (msg.method === 'thread/start') {
    threadCounter += 1;
    const threadId =
      mode === 'shared-thread-abort' ? `thread-shared-${threadCounter}` : 'thread-stdio-1';
    const cwd = typeof msg.params?.cwd === 'string' ? msg.params.cwd : root;
    const now = Math.floor(Date.now() / 1000);
    write({
      id: msg.id,
      result: {
        thread: {
          id: threadId,
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: now,
          updatedAt: now,
          status: { type: 'idle' },
          path: null,
          cwd,
          cliVersion: '0.118.0',
          source: 'appServer',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-5-codex',
        modelProvider: 'openai',
        cwd,
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite' },
      },
    });
    if (mode === 'shared-thread-abort') {
      // Send after thread-shared-1 is already registered on the client (when thread-shared-2 opens).
      if (threadCounter === 2) {
        write({
          id: 'shared-ext-1',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-shared-1',
            turnId: 'ext-turn-1',
            itemId: 'cmd-shared-ext',
            command: 'echo shared-ext',
          },
        });
      }
    } else {
      write({
        id: 'ext-abort-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-other',
          turnId: 'turn-other',
          itemId: 'cmd-1',
          command: 'echo hello',
        },
      });
    }
  } else if (msg.method === 'turn/start') {
    const threadId =
      typeof msg.params?.threadId === 'string' ? msg.params.threadId : 'thread-1';
    const turnId = `native-${threadId}-1`;
    write({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    if (mode === 'shared-thread-abort' && threadId === 'thread-shared-1') {
      write({
        id: 'shared-act-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId,
          turnId,
          itemId: 'cmd-shared-act',
          command: 'echo shared-act',
        },
      });
    } else if (mode === 'shared-thread-abort' && threadId === 'thread-shared-2') {
      write({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'msg-2', delta: 'sibling-ok' },
      });
      write({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
      });
    }
  } else if (msg.method === 'turn/interrupt' || msg.method === 'thread/unsubscribe') {
    write({ id: msg.id, result: {} });
  }
}
