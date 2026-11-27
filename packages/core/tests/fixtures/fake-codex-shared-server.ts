/**
 * Minimal multi-thread fake `codex app-server` over stdio for testing {@link CodexSharedServer}.
 * Assigns distinct sequential threadIds, handles interleaved concurrent `turn/start` calls with
 * per-thread `item/commandExecution/requestApproval` prompts, logs `thread/unsubscribe` and
 * `thread/resume`, supports optional delayed `thread/start` via `FAKE_SHARED_START_DELAY_MS`,
 * emits `account/rateLimits/updated` on `EMIT_RATE_LIMIT`, and crashes on `CRASH_SERVER`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.CODEX_HOME ?? '/tmp';
mkdirSync(home, { recursive: true });
const unsubscribedLog = join(home, 'unsubscribed.jsonl');
const resumedLog = join(home, 'resumed.jsonl');
const interruptedLog = join(home, 'turn-interrupt.jsonl');
const steeredLog = join(home, 'turn-steer.jsonl');
const startDelayMs = Number(process.env.FAKE_SHARED_START_DELAY_MS ?? '0');

let nextThreadSeq = 0;
let nextTurnSeq = 0;
let nextReqId = 900;
const pendingApprovals = new Map<
  number,
  { readonly threadId: string; readonly turnId: string; readonly text: string }
>();

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleLine(line: string): void {
  const msg = JSON.parse(line);
  if (msg.method === undefined && typeof msg.id === 'number') {
    appendFileSync(join(home, 'responses.jsonl'), `${JSON.stringify(msg)}\n`);
    const entry = pendingApprovals.get(msg.id);
    if (entry === undefined) return;
    pendingApprovals.delete(msg.id);
    const decision = msg.result?.decision ?? 'decline';
    if (decision === 'cancel') return;
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: entry.threadId,
        turnId: entry.turnId,
        itemId: `msg-${entry.turnId}`,
        delta: `${entry.threadId}:${entry.text}:${decision}`,
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: entry.threadId,
        turn: { id: entry.turnId, status: 'completed', items: [] },
      },
    });
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { userAgent: 'fake-codex-shared' } });
      return;
    case 'initialized':
      return;
    case 'thread/start': {
      nextThreadSeq += 1;
      const threadId = `shared-thread-${nextThreadSeq}`;
      const reply = () =>
        send({
          id: msg.id,
          result: {
            thread: { id: threadId },
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            approvalPolicy: 'on-request',
          },
        });
      if (startDelayMs > 0) setTimeout(reply, startDelayMs);
      else reply();
      return;
    }
    case 'thread/resume': {
      const threadId = String(msg.params?.threadId ?? '');
      appendFileSync(resumedLog, `${JSON.stringify({ threadId })}\n`);
      send({
        id: msg.id,
        result: {
          thread: { id: threadId },
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          approvalPolicy: 'on-request',
        },
      });
      return;
    }
    case 'thread/unsubscribe': {
      const threadId = String(msg.params?.threadId ?? '');
      appendFileSync(unsubscribedLog, `${JSON.stringify({ threadId })}\n`);
      send({ id: msg.id, result: { status: 'unsubscribed' } });
      return;
    }
    case 'thread/loaded/list': {
      send({ id: msg.id, result: { data: [] } });
      return;
    }
    case 'turn/start': {
      const prevTurnId = nextTurnSeq > 0 ? `turn-${nextTurnSeq}` : undefined;
      nextTurnSeq += 1;
      const threadId = String(msg.params?.threadId ?? '');
      const turnId = `turn-${nextTurnSeq}`;
      const inputItems = Array.isArray(msg.params?.input) ? msg.params.input : [];
      const firstText = String(inputItems[0]?.text ?? '');
      if (firstText.includes('HOLD_START_EARLY')) {
        nextReqId += 1;
        const reqId = nextReqId;
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            turnId,
            itemId: `msg-early-${turnId}`,
            delta: `${threadId}:early-held`,
          },
        });
        send({
          id: reqId,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: `cmd-early-${turnId}`,
            command: `echo ${threadId}`,
          },
        });
        writeFileSync(join(home, `hold-started-${threadId}.txt`), String(reqId));
        const replyDelayMs = firstText.includes('LATE_SUCCESS') ? 120 : 10_000;
        setTimeout(() => {
          send({ id: msg.id, result: { turn: { id: turnId } } });
        }, replyDelayMs);
        return;
      }
      if (firstText.includes('EARLY_BEFORE_REPLY')) {
        if (prevTurnId !== undefined) {
          send({
            method: 'turn/completed',
            params: {
              threadId,
              turn: { id: prevTurnId, status: 'completed', items: [] },
            },
          });
        }
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            turnId,
            itemId: `msg-${turnId}`,
            delta: `${threadId}:${firstText}`,
          },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: { id: turnId, status: 'completed', items: [] },
          },
        });
        send({ id: msg.id, result: { turn: { id: turnId } } });
        return;
      }
      send({ id: msg.id, result: { turn: { id: turnId } } });
      if (firstText.includes('STALE_PREV_TURN_COMPLETED') && prevTurnId !== undefined) {
        send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: { id: prevTurnId, status: 'completed', items: [] },
          },
        });
      }
      if (firstText.includes('CRASH_SERVER')) {
        setTimeout(() => {
          process.stderr.write('simulated shared server crash\n');
          process.exit(1);
        }, 25);
        return;
      }
      if (firstText.includes('EMIT_RATE_LIMIT')) {
        send({
          method: 'account/rateLimits/updated',
          params: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_900_000_000 },
            },
          },
        });
      }
      if (firstText.includes('NEEDS_APPROVAL')) {
        nextReqId += 1;
        const reqId = nextReqId;
        pendingApprovals.set(reqId, { threadId, turnId, text: firstText });
        send({
          id: reqId,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: `cmd-${turnId}`,
            command: `echo ${threadId}`,
          },
        });
        return;
      }
      send({
        method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId,
          itemId: `msg-${turnId}`,
          delta: `${threadId}:${firstText}`,
        },
      });
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: turnId, status: 'completed', items: [] },
        },
      });
      return;
    }
    case 'thread/compact/start':
      appendFileSync(
        join(home, 'thread-compact.jsonl'),
        `${JSON.stringify(msg.params ?? {})}\n`,
      );
      send({ id: msg.id, result: {} });
      return;
    case 'turn/steer':
      appendFileSync(steeredLog, `${JSON.stringify(msg.params ?? {})}\n`);
      send({ id: msg.id, result: { turnId: String(msg.params?.expectedTurnId ?? 'turn-1') } });
      return;
    case 'turn/interrupt': {
      appendFileSync(interruptedLog, `${JSON.stringify(msg.params ?? {})}\n`);
      send({ id: msg.id, result: {} });
      const threadId = String(msg.params?.threadId ?? '');
      const turnId = String(msg.params?.turnId ?? '');
      if (threadId.length > 0 && turnId.length > 0) {
        for (const [reqId, entry] of pendingApprovals) {
          if (entry.threadId === threadId && entry.turnId === turnId) {
            pendingApprovals.delete(reqId);
          }
        }
        send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: { id: turnId, status: 'interrupted', items: [] },
          },
        });
      }
      return;
    }
    default:
      if (msg.id !== undefined) {
        send({
          id: msg.id,
          error: { code: -32601, message: `Unknown ${String(msg.method)}` },
        });
      }
  }
}

writeFileSync(join(home, 'shared-pid.txt'), String(process.pid));
createInterface({ input: process.stdin }).on('line', handleLine);
