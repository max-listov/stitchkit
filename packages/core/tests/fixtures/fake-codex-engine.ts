/**
 * A scripted Codex app-server for the driver's conformance and regressions: answers
 * `--version`, `login status` and the protocol requests over stdio or RFC 6455
 * WebSocket-over-Unix-socket (`--listen unix://<path>`), keeps each turn's
 * `clientUserMessageId` where `thread/turns/list` finds it, and plays the scenario
 * in `FAKE_ENGINE_SCENARIO` once a turn starts.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { FakeEngineScenarioSchema } from '../../src/agent-executor/testing/fake-engine';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

if (process.env.FAKE_ENGINE_PID_FILE !== undefined) {
  mkdirSync(dirname(process.env.FAKE_ENGINE_PID_FILE), { recursive: true });
  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, String(process.pid));
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.9.9\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}
const home = process.env.CODEX_HOME ?? '/nonexistent';
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'argv.json'), JSON.stringify(args));

if (process.env.FAKE_CODEX_EXIT_EARLY === '1') {
  process.stderr.write('early startup boom\n');
  process.exit(2);
}

const ledger = join(home, 'client-ids.jsonl');
const scenario = FakeEngineScenarioSchema.parse(
  JSON.parse(readFileSync(process.env.FAKE_ENGINE_SCENARIO ?? '/nonexistent', 'utf8')),
);
const extraThreadContext =
  process.env.FAKE_CODEX_THREAD_CONTEXT !== undefined
    ? JSON.parse(process.env.FAKE_CODEX_THREAD_CONTEXT)
    : {};
const extraThreadFields =
  process.env.FAKE_CODEX_THREAD_EXTRA !== undefined
    ? JSON.parse(process.env.FAKE_CODEX_THREAD_EXTRA)
    : {};
const customRateLimits =
  process.env.FAKE_CODEX_RATE_LIMITS !== undefined
    ? JSON.parse(process.env.FAKE_CODEX_RATE_LIMITS)
    : {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1796032800 },
        },
      };

const clientIds = () => {
  try {
    return readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const broadcastClients = new Set<(line: string) => void>();
const sharedResolved = new Set<string>();
const sharedWaiting: { type: string; resolve(): void }[] = [];
const sharedBuffered: string[] = [];

function createSessionHandler(writeLine: (line: string) => void) {
  const shared = process.env.FAKE_CODEX_BROADCAST_TUI === '1';
  const write = (message: unknown) => writeLine(JSON.stringify(message));
  const broadcast = (message: unknown) => {
    const line = JSON.stringify(message);
    if (shared && broadcastClients.size > 0) {
      for (const client of broadcastClients) client(line);
      return;
    }
    writeLine(line);
  };
  const waiting: { type: string; resolve(): void }[] = shared ? sharedWaiting : [];
  const buffered: string[] = shared ? sharedBuffered : [];
  const seen = (type: string) => {
    const index = waiting.findIndex((entry) => entry.type === type);
    if (index !== -1) {
      waiting.splice(index, 1)[0]?.resolve();
      return;
    }
    buffered.push(type);
  };
  const expectEvent = (type: string) => {
    const index = buffered.indexOf(type);
    if (index !== -1) {
      buffered.splice(index, 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push({ type, resolve }));
  };
  const play = async () => {
    for (const step of scenario.steps) {
      if (step.do === 'emit') broadcast(step.record);
      else if (step.do === 'emit-raw') writeLine(step.line);
      else if (step.do === 'delay')
        await new Promise((resolve) => setTimeout(resolve, step.ms));
      else if (step.do === 'expect') await expectEvent(step.type);
      else if (step.do === 'exit') process.exit(step.code);
      else process.kill(process.pid, 'SIGKILL');
    }
  };

  return (line: string) => {
    const message = JSON.parse(line);
    if (message.method === undefined) {
      appendFileSync(join(home, 'responses.jsonl'), `${JSON.stringify(message)}\n`);
      if (
        process.env.FAKE_CODEX_BROADCAST_TUI === '1' &&
        message.id !== undefined &&
        message.error === undefined &&
        !sharedResolved.has(String(message.id))
      ) {
        sharedResolved.add(String(message.id));
        broadcast({ method: 'serverRequest/resolved', params: { requestId: message.id } });
      }
      seen('response');
      return;
    }
    seen(message.method);
    if (message.id === undefined) {
      if (message.method === 'initialized')
        appendFileSync(join(home, 'initialized.jsonl'), '1\n');
      return;
    }
    const reply = (result: unknown) => write({ id: message.id, result });
    const logRpc = () =>
      appendFileSync(
        join(home, 'rpc.jsonl'),
        `${JSON.stringify({ method: message.method, params: message.params })}\n`,
      );
    switch (message.method) {
      case 'initialize': {
        appendFileSync(join(home, 'initialize.jsonl'), `${JSON.stringify(message.params)}\n`);
        if (process.env.FAKE_CODEX_INITIALIZE_REPLY !== undefined) {
          reply(JSON.parse(process.env.FAKE_CODEX_INITIALIZE_REPLY));
        } else if (process.env.FAKE_CODEX_USER_AGENT === '__OMIT__') {
          reply({ codexHome: home });
        } else {
          reply({
            userAgent: process.env.FAKE_CODEX_USER_AGENT ?? 'fake',
            codexHome: home,
          });
        }
        break;
      }
      case 'thread/start':
        appendFileSync(
          join(home, 'thread-start.jsonl'),
          `${JSON.stringify(message.params)}\n`,
        );
        reply({ thread: { id: 'fake-thread', ...extraThreadFields }, ...extraThreadContext });
        break;
      case 'thread/resume':
        appendFileSync(
          join(home, 'thread-resume.jsonl'),
          `${JSON.stringify(message.params)}\n`,
        );
        reply({
          thread: { id: message.params?.threadId ?? 'fake-thread', ...extraThreadFields },
          ...extraThreadContext,
        });
        break;
      case 'thread/fork':
        appendFileSync(join(home, 'thread-fork.jsonl'), `${JSON.stringify(message.params)}\n`);
        reply({
          thread: { id: 'forked-thread', ...extraThreadFields },
          ...extraThreadContext,
        });
        break;
      case 'thread/compact/start':
        appendFileSync(
          join(home, 'thread-compact.jsonl'),
          `${JSON.stringify(message.params)}\n`,
        );
        reply({});
        break;
      case 'turn/start':
        buffered.length = 0;
        appendFileSync(join(home, 'turn-start.jsonl'), `${JSON.stringify(message.params)}\n`);
        appendFileSync(ledger, `${message.params.clientUserMessageId}\n`);
        reply({
          turn: {
            id: process.env.FAKE_CODEX_TURN_ID ?? 'fake-turn',
            status: 'inProgress',
            items: [],
          },
        });
        void play();
        break;
      case 'turn/steer':
        appendFileSync(join(home, 'turn-steer.jsonl'), `${JSON.stringify(message.params)}\n`);
        reply({ turnId: message.params?.expectedTurnId ?? 'fake-turn' });
        break;
      case 'turn/interrupt':
        appendFileSync(
          join(home, 'turn-interrupt.jsonl'),
          `${JSON.stringify(message.params)}\n`,
        );
        reply({});
        break;
      case 'config/read':
        logRpc();
        reply({
          config: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
          origins: {},
        });
        break;
      case 'mcpServerStatus/list':
        logRpc();
        reply({ data: JSON.parse(process.env.FAKE_CODEX_MCP_SERVERS ?? '[]') });
        break;
      case 'skills/list':
        logRpc();
        reply({ data: JSON.parse(process.env.FAKE_CODEX_SKILLS ?? '[]') });
        break;
      case 'model/list':
        logRpc();
        reply({ data: [{ id: 'gpt-5-codex', model: 'gpt-5-codex' }] });
        break;
      case 'account/read':
        logRpc();
        reply({
          account: { type: 'chatgpt', email: 'dev@example.invalid' },
          requiresOpenaiAuth: true,
        });
        break;
      case 'thread/read': {
        logRpc();
        const oversizedBytes = Number(process.env.FAKE_CODEX_OVERSIZED_BYTES ?? '0');
        reply({
          thread: {
            id: message.params?.threadId ?? 'fake-thread',
            status: { type: 'idle' },
            canAcceptDirectInput: true,
            ...(oversizedBytes > 0 && { pad: 'x'.repeat(oversizedBytes) }),
          },
        });
        break;
      }
      case 'collaborationMode/list':
        logRpc();
        reply({
          data: [
            { name: 'Plan', mode: 'plan' },
            { name: 'Default', mode: 'default' },
          ],
        });
        break;
      case 'thread/turns/list':
        logRpc();
        reply({
          data: clientIds().map((clientId, index) => ({
            id: `turn-${index}`,
            status: 'completed',
            items: [{ type: 'userMessage', id: `m-${index}`, clientId }],
          })),
        });
        break;
      case 'thread/items/list':
        logRpc();
        reply({
          data: [
            {
              turnId: message.params?.turnId ?? 'turn-0',
              item: { type: 'contextCompaction', id: 'cmp-1' },
            },
          ],
          nextCursor: null,
        });
        break;
      case 'thread/revert':
        logRpc();
        reply({
          thread: { id: message.params?.threadId ?? 'fake-thread', turns: [] },
          turnsBackwardsCursor: 'turns-back-1',
          itemsBackwardsCursor: 'items-back-1',
        });
        break;
      case 'thread/inject_items':
        logRpc();
        if (process.env.FAKE_CODEX_INJECT_UNSUPPORTED === '1') {
          write({
            id: message.id,
            error: { code: -32601, message: 'thread/inject_items is not supported' },
          });
        } else {
          reply({});
        }
        break;
      case 'thread/unsubscribe':
        logRpc();
        reply({ status: 'unsubscribed' });
        break;
      case 'thread/list':
        logRpc();
        reply({
          data: [{ id: 'fake-thread', status: { type: 'idle' } }],
          nextCursor: null,
          backwardsCursor: 'back-0',
        });
        break;
      case 'thread/loaded/list':
        logRpc();
        reply({ data: ['fake-thread'], nextCursor: null });
        break;
      case 'thread/archive':
        logRpc();
        reply({});
        break;
      case 'thread/unarchive':
        logRpc();
        reply({ thread: { id: message.params?.threadId ?? 'fake-thread' } });
        break;
      case 'thread/metadata/update':
        logRpc();
        reply({ thread: { id: message.params?.threadId ?? 'fake-thread' } });
        break;
      case 'thread/name/set':
        logRpc();
        reply({});
        break;
      case 'account/rateLimits/read':
        reply(customRateLimits);
        break;
      default:
        write({
          id: message.id,
          error: { code: -32601, message: `${message.method} is not faked` },
        });
    }
  };
}

function encodeServerWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.byteLength;
  const headerLen = len < 126 ? 2 : len <= 0xffff ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) frame[1] = len;
  else if (len <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 127;
    frame.writeUInt32BE(Math.floor(len / 0x1_0000_0000), 2);
    frame.writeUInt32BE(len >>> 0, 6);
  }
  payload.copy(frame, headerLen);
  return frame;
}

function attachWsClient(socket: Socket) {
  let upgraded = false;
  let buf: Buffer = Buffer.alloc(0);
  const sendText = (text: string) => {
    if (!socket.destroyed && socket.writable) {
      socket.write(encodeServerWsFrame(0x1, Buffer.from(text, 'utf8')));
    }
  };
  broadcastClients.add(sendText);
  socket.once('close', () => {
    broadcastClients.delete(sendText);
  });
  const onLine = createSessionHandler(sendText);

  socket.on('data', (chunk: Buffer) => {
    buf = buf.byteLength === 0 ? chunk : Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.subarray(0, idx).toString('latin1');
      buf = Buffer.from(buf.subarray(idx + 4));
      const keyMatch = /^sec-websocket-key:\s*(.+)$/im.exec(head);
      const accept = createHash('sha1')
        .update(`${(keyMatch?.[1] ?? '').trim()}${WS_MAGIC_GUID}`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      upgraded = true;
    }
    let offset = 0;
    while (buf.byteLength - offset >= 2) {
      const b0 = buf[offset] ?? 0;
      const b1 = buf[offset + 1] ?? 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let headerLen = 2;
      if (len === 126) {
        if (buf.byteLength - offset < 4) break;
        len = buf.readUInt16BE(offset + 2);
        headerLen = 4;
      } else if (len === 127) {
        if (buf.byteLength - offset < 10) break;
        len = buf.readUInt32BE(offset + 2) * 0x1_0000_0000 + buf.readUInt32BE(offset + 6);
        headerLen = 10;
      }
      const maskOffset = offset + headerLen;
      const bodyOffset = maskOffset + (masked ? 4 : 0);
      if (buf.byteLength < bodyOffset + len) break;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) {
        const raw = buf[bodyOffset + i] ?? 0;
        payload[i] = masked ? raw ^ (buf[maskOffset + (i & 3)] ?? 0) : raw;
      }
      offset = bodyOffset + len;
      if (opcode === 0x8) {
        socket.end(encodeServerWsFrame(0x8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeServerWsFrame(0xa, payload));
      } else if (opcode === 0x1) {
        onLine(payload.toString('utf8'));
      }
    }
    if (offset > 0) buf = Buffer.from(buf.subarray(offset));
  });
}

const listenIdx = args.indexOf('--listen');
const listenArg = listenIdx !== -1 ? args[listenIdx + 1] : undefined;

if (listenArg?.startsWith('unix://')) {
  const socketPath = listenArg.slice('unix://'.length);
  const actualSocket =
    process.env.FAKE_CODEX_SYMLINK_SOCKET === '1'
      ? join(dirname(socketPath), '.real-daemon.sock')
      : socketPath;
  const server = createServer(attachWsClient);
  server.listen(actualSocket, () => {
    if (actualSocket !== socketPath) symlinkSync(actualSocket, socketPath);
    if (process.env.FAKE_CODEX_SPAM_STDOUT === '1') {
      // Exceed streamNativeCommand's 1 MiB stdout buffer to verify stdoutMode: 'drain'.
      process.stdout.write(`${'x'.repeat(1_500_000)}\n`);
    }
  });
} else {
  const onLine = createSessionHandler((line) => process.stdout.write(`${line}\n`));
  for await (const line of createInterface({ input: process.stdin })) {
    onLine(line);
  }
}
