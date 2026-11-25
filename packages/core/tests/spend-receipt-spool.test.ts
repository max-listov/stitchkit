import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpooledSpendStore } from '../src/spend/receipt-spool';
import { memorySpendLedger } from './support/spend-ledger';

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stitchkit-spend-receipt-spool-'));
  path = join(directory, 'spend.ndjson');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('createSpooledSpendStore without double JSON round-trip', () => {
  test('spools and recovers attempts and receipts carrying explicit undefined optional fields', async () => {
    const downStore = {
      begin: async () => {
        throw new Error('ledger offline');
      },
      settle: async () => {
        throw new Error('ledger offline');
      },
    };
    const spooled = createSpooledSpendStore({ store: downStore, path });

    await spooled.begin({
      attemptId: 'att-undef-1',
      gateway: 'models',
      startedAt: '2026-11-24T00:00:00.000Z',
      attribution: { purpose: 'live', traceId: undefined },
      request: { method: 'POST', origin: 'https://models.example', path: '/v1/chat' },
    });
    await spooled.settle({
      attemptId: 'att-undef-1',
      rank: 1,
      at: '2026-11-24T00:00:01.000Z',
      outcome: 'succeeded',
      facts: {
        costStatus: 'reported',
        costUsd: 0.12,
        inputTokens: 100,
        outputTokens: undefined,
      },
    });
    expect(spooled.pending()).toBe(2);

    const ledger = memorySpendLedger();
    const recovering = createSpooledSpendStore({ store: ledger.store, path });
    expect(await recovering.recover()).toEqual({ replayed: 2, failed: 0 });
    expect(recovering.pending()).toBe(0);
    expect(ledger.attempts.get('att-undef-1')).toMatchObject({
      attemptId: 'att-undef-1',
      gateway: 'models',
      attribution: { purpose: 'live' },
    });
    expect(ledger.receipts.get('att-undef-1')).toMatchObject({
      attemptId: 'att-undef-1',
      rank: 1,
      outcome: 'succeeded',
      facts: { costStatus: 'reported', costUsd: 0.12, inputTokens: 100 },
    });

    // Compaction after recovery leaves only the 0600 spool file and zero temp files.
    expect(readdirSync(directory)).toEqual(['spend.ndjson']);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});

describe('createSpooledSpendStore recover racing a live write', () => {
  test('a record refused while recover runs stays ahead of the next record of its attempt', async () => {
    const attempt = (attemptId: string) => ({
      attemptId,
      gateway: 'models',
      startedAt: '2026-11-24T00:00:00.000Z',
      attribution: { purpose: 'live' },
      request: { method: 'POST', origin: 'https://models.example', path: '/v1/chat' },
    });
    // An earlier process left attempt `left` undelivered.
    const offline = createSpooledSpendStore({
      store: {
        begin: async () => {
          throw new Error('ledger offline');
        },
        settle: async () => undefined,
      },
      path,
    });
    await offline.begin(attempt('left'));

    const calls: string[] = [];
    let releaseReplay: () => void = () => undefined;
    const replayHeld = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let replayStarted: () => void = () => undefined;
    const replaying = new Promise<void>((resolve) => {
      replayStarted = resolve;
    });
    let refuseLive = true;
    const store = createSpooledSpendStore({
      store: {
        begin: async (value) => {
          calls.push(`begin ${value.attemptId}`);
          if (value.attemptId === 'left') {
            replayStarted();
            await replayHeld;
          } else if (refuseLive) throw new Error('ledger busy');
        },
        settle: async (receipt) => void calls.push(`settle ${receipt.attemptId}`),
      },
      path,
    });
    const recovering = store.recover();
    // The live write lands once the replay is offering what it read from the file.
    await replaying;
    await store.begin(attempt('live'));
    releaseReplay();
    expect(await recovering).toEqual({ replayed: 1, failed: 0 });
    expect(store.pending()).toBe(1);

    refuseLive = false;
    await store.settle({
      attemptId: 'live',
      rank: 1,
      at: '2026-11-24T00:00:01.000Z',
      outcome: 'succeeded',
      facts: { costStatus: 'reported', costUsd: 0.01 },
    });
    expect(calls).toEqual(['begin left', 'begin live', 'begin live', 'settle live']);
    expect(store.pending()).toBe(0);
  });
});
