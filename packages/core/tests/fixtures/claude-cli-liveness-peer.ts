import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [root, mode] = process.argv.slice(2);
if (root === undefined || mode === undefined) {
  throw new Error('Usage: claude-cli-liveness-peer.ts <root> <mode>');
}
if (process.argv.includes('auth') && process.argv.includes('status')) {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })}\n`);
  process.exit(0);
}

writeFileSync(join(root, 'pid'), String(process.pid));

const write = (record: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
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
if (mode === 'abort-active') {
  process.on('SIGTERM', () => {
    if (sigtermHandled) return;
    sigtermHandled = true;
    write({
      type: 'stream_event',
      api_message_id: 'm-late',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'late-after-abort' },
      },
    });
    write({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        rateLimitType: 'five_hour',
        utilization: 0.99,
      },
    });
    write({
      type: 'control_request',
      request_id: 'req-late-after-abort',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tu-late',
        input: { command: 'echo late' },
      },
    });
    writeFileSync(join(root, 'sigterm-received'), '1');
    waitForRelease('release-exit', () => process.exit(0));
  });
}

if (mode === 'disconnect-active') {
  const poll = setInterval(() => {
    if (existsSync(join(root, 'trigger-exit'))) {
      clearInterval(poll);
      process.exit(1);
    }
  }, 10);
  poll.unref();
}

let userCount = 0;
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (line.trim().length === 0) continue;
  appendFileSync(join(root, 'stdin.jsonl'), `${line}\n`);
  const record = JSON.parse(line);
  if (record.type === 'user') {
    userCount += 1;
    if (mode === 'live-positive') {
      write({
        type: 'control_request',
        request_id: 'req-live-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'tu-live',
          input: { command: 'echo live' },
        },
      });
    } else if (
      mode === 'close-active' ||
      mode === 'disconnect-active' ||
      mode === 'abort-active'
    ) {
      write({
        type: 'control_request',
        request_id: 'req-act-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'tu-act',
          input: { command: 'echo held' },
        },
      });
    } else if (mode === 'settled-interrupt') {
      if (userCount === 1) {
        write({ type: 'result', subtype: 'success', is_error: false, result: 'turn-1-done' });
      } else {
        write({
          type: 'stream_event',
          api_message_id: 'm-t2',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'turn-2-live' },
          },
        });
        waitForRelease('release-turn-2', () => {
          write({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'turn-2-done',
          });
        });
      }
    }
  } else if (record.type === 'control_response' && mode === 'live-positive') {
    write({ type: 'result', subtype: 'success', is_error: false, result: 'live-done' });
  }
}
