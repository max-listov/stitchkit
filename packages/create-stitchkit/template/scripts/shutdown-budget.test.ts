import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CleanupResult,
  closeWithinBudget,
  concludeShutdown,
} from '../packages/backend/src/cleanup';
import { appDeclaration } from '../packages/config/src/declaration';
import { CLEANUP_BUDGET_MS, FORCE_BUDGET_MS } from '../packages/config/src/shutdown';
import { terminationBudgetMs } from './declaration';

describe('the termination budget is an upper bound, not an estimate', () => {
  test('the budget is exactly the three bounded parts', () => {
    for (const role of appDeclaration.roles) {
      expect(terminationBudgetMs(role)).toBe(
        role.drainFloorMs + FORCE_BUDGET_MS + CLEANUP_BUDGET_MS,
      );
    }
  });

  test('a cleanup that finishes reports nothing unfinished', async () => {
    const closed: string[] = [];
    const result = await closeWithinBudget([
      { name: 'MCP', close: async () => closed.push('MCP') },
      { name: 'database', close: async () => closed.push('database') },
    ]);
    expect(closed).toEqual(['MCP', 'database']);
    expect(result.unfinished).toEqual([]);
  });

  test('a close that hangs stops being waited for, and is named', async () => {
    // The defect this exists for: the drain had a deadline, the closes after it
    // had none, so a hung MCP session or database pool ran past the very kill
    // timeout the budget had told the supervisor to allow — turning an orderly
    // shutdown into the SIGKILL that runs no cleanup at all.
    const result = await closeWithinBudget(
      [{ name: 'MCP', close: () => new Promise<void>(() => undefined) }],
      25,
    );
    expect(result.unfinished).toEqual(['MCP']);
    expect(result.durationMs).toBeLessThan(CLEANUP_BUDGET_MS);
  });

  test('the steps share one budget rather than each getting a full one', async () => {
    const started: string[] = [];
    const hangingClose = (name: string) => () => {
      started.push(name);
      return new Promise<void>(() => undefined);
    };
    const names = Array.from({ length: 10 }, (_, index) => `resource-${index + 1}`);
    const result = await closeWithinBudget(
      names.map((name) => ({ name, close: hangingClose(name) })),
      25,
    );
    expect(result.unfinished).toEqual(names);
    // Timer rounding may let one close start on a sub-millisecond remainder,
    // so no exact boundary is contractual. What a fresh per-step budget would
    // do is start every close; one shared deadline must skip at least one. This
    // proves the state transition directly without treating scheduler latency
    // as a product failure.
    expect(started.length).toBeLessThan(names.length);
  });

  test('a close that fails is a failure, and keeps its cause', async () => {
    // It used to be swallowed into `undefined` with the note that the budget is
    // about time. The budget is — but a close that throws is a shutdown that
    // did not happen, and reporting it as a clean exit with the reason gone is
    // how a broken shutdown looks exactly like a working one.
    const result = await closeWithinBudget([
      { name: 'database', close: () => Promise.reject(new Error('pool already gone')) },
    ]);
    expect(result.unfinished).toEqual([]);
    expect(result.failed.map((failure) => failure.name)).toEqual(['database']);
    expect(result.failed[0]?.cause).toBeInstanceOf(Error);
  });

  test('a cleanup that completed is a zero exit and no forced ending', () => {
    let exited: number | undefined;
    concludeShutdown({ unfinished: [], failed: [], durationMs: 3 }, true, (code) => {
      exited = code;
    });
    expect(process.exitCode).toBe(0);
    expect(exited).toBeUndefined();
    process.exitCode = 0;
  });

  test('an unfinished step and a failed one both end the process non-zero', () => {
    const endings: Array<[string, CleanupResult]> = [
      ['unfinished', { unfinished: ['database'], failed: [], durationMs: 5 }],
      [
        'failed',
        {
          unfinished: [],
          failed: [{ name: 'database', cause: new Error('pool already gone') }],
          durationMs: 5,
        },
      ],
    ];
    for (const [label, result] of endings) {
      let exited: number | undefined;
      concludeShutdown(result, true, (code) => {
        exited = code;
      });
      expect(`${label}:${exited}`).toBe(`${label}:1`);
    }
    process.exitCode = 0;
  });

  test('the role bounds its own cleanup rather than awaiting it bare', () => {
    // One number, two readers — and the reader that matters is the role. An
    // `await mcp.close()` here with nothing around it is the whole defect.
    const source = readFileSync(
      resolve(import.meta.dir, '../packages/backend/src/index.ts'),
      'utf8',
    );
    expect(source).toContain('closeWithinBudget');
    expect(source).not.toMatch(/await mcp\.close\(\);/);
    expect(source).not.toMatch(/await prisma\.\$disconnect\(\);/);
  });
});

describe('a spent budget ends the process itself', () => {
  const fixture = resolve(import.meta.dir, 'shutdown-budget.fixture.ts');

  async function runFixture(mode: string, budgetMs: number, waitMs: number) {
    const child = Bun.spawn(['bun', fixture, String(budgetMs), mode], {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const startedAt = Date.now();
    const timeout = Bun.sleep(waitMs).then(() => 'timeout');
    const finished = await Promise.race([child.exited, timeout]);
    const elapsed = Date.now() - startedAt;
    if (finished === 'timeout') {
      child.kill('SIGKILL');
      await child.exited;
      return { exitCode: undefined, elapsed, stdout: '', stderr: '' };
    }
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode: finished, elapsed, stdout, stderr };
  }

  test('a role whose close never finishes exits anyway, and says so', async () => {
    const run = await runFixture('hang', 200, 8_000);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('the cleanup budget is spent, exiting anyway');
    // Well inside a supervisor's kill timeout, which is what the declared
    // termination budget promises this stays inside.
    expect(run.elapsed).toBeLessThan(5_000);
  }, 20_000);

  test('a role whose close throws exits non-zero, with the cause', async () => {
    const run = await runFixture('throw', 200, 8_000);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Shutdown could not close database');
    expect(run.stderr).toContain('pool already gone');
  }, 20_000);

  test('the held handle really does hold — without it the test proves nothing', async () => {
    // Falsification. If this process ended on its own, the two assertions above
    // would pass with `concludeShutdown` deleted, and the regression would be
    // measuring the absence of work rather than the presence of an ending.
    const run = await runFixture('clean', 200, 1_500);
    expect(run.exitCode).toBeUndefined();
  }, 20_000);
});
