import { expect, test } from 'bun:test';
import { CodexLimitBook } from '../../src/agent-executor/codex/limits';
import { claudeUsagePlanLimits as cliUsage } from '../../src/entrypoints/agent-executor/claude';
import { claudeUsagePlanLimits as sdkUsage } from '../../src/entrypoints/agent-executor/claude-sdk';
import { codexPlanLimits, codexPlanWindows } from '../../src/entrypoints/agent-executor/codex';

const account = {
  limitId: 'codex',
  planType: 'pro',
  primary: { usedPercent: 91, windowDurationMins: 10_080 },
};
const model = {
  limitId: 'model',
  primary: { usedPercent: 6, windowDurationMins: 300 },
  secondary: { usedPercent: 3, windowDurationMins: 10_080 },
};
const weekly = { name: 'codex:10080m', usedPercent: 91, windowDurationMins: 10_080 };

test('Codex preserves the account and model windows across bare, wrapped and inline snapshots', () => {
  const rateLimitsByLimitId = { model };
  const modelWindows = [
    { name: 'model:300m', usedPercent: 6, windowDurationMins: 300 },
    { name: 'model:10080m', usedPercent: 3, windowDurationMins: 10_080 },
  ];
  for (const raw of [
    { ...account, rateLimitsByLimitId },
    { rateLimits: account, rateLimitsByLimitId },
    {
      limit_id: 'codex',
      plan_type: 'pro',
      primary: { used_percent: 91, window_minutes: 10_080 },
      rate_limits_by_limit_id: rateLimitsByLimitId,
    },
  ]) {
    const { answer, plan, windows } = codexPlanLimits(raw);
    expect({ answer, plan, windows }).toEqual({
      answer: 'known',
      plan: 'pro',
      windows: [weekly, ...modelWindows],
    });
    expect(codexPlanWindows(raw)).toEqual(windows);
  }
  expect(codexPlanLimits(account)).toMatchObject({
    answer: 'known',
    plan: 'pro',
    windows: [weekly],
  });
});

test('Codex keeps real account measurements through partial duplicates and the window cap', () => {
  const invalid = { primary: { usedPercent: -1 } };
  expect(codexPlanLimits({ ...invalid, rateLimitsByLimitId: { invalid } })).toMatchObject({
    answer: 'unpublished',
    windows: [],
  });
  for (const duplicate of [{}, invalid, account]) {
    expect(
      codexPlanWindows({ ...account, rateLimitsByLimitId: { codex: duplicate } }),
    ).toEqual([weekly]);
  }
  const duplicate = {
    primary: { used_percent: 0, window_minutes: 10_080 },
    secondary: { usedPercent: 12, windowDurationMins: 300 },
  };
  expect(
    codexPlanWindows({ rateLimits: account, rateLimitsByLimitId: { codex: duplicate } }),
  ).toEqual([
    { ...weekly, usedPercent: 0 },
    { name: 'codex:300m', usedPercent: 12, windowDurationMins: 300 },
  ]);
  const full = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      `model${i}`,
      { planType: 'model-plan', primary: { usedPercent: i } },
    ]),
  );
  const snapshot = codexPlanLimits({ ...account, rateLimitsByLimitId: full });
  expect(snapshot.plan).toBe('pro');
  expect(snapshot.windows).toHaveLength(32);
  expect(snapshot.windows).toContainEqual(weekly);
  const accountMap = {
    ...full,
    codex: { ...account, secondary: { usedPercent: 17, windowDurationMins: 300 } },
  };
  for (const rateLimits of [{}, { ...account, primary: null }, account]) {
    const result = codexPlanLimits({ rateLimits, rateLimitsByLimitId: accountMap });
    expect(result.plan).toBe('pro');
    expect(result.windows).toHaveLength(32);
    expect(result.windows.slice(0, 2)).toEqual([
      weekly,
      { name: 'codex:300m', usedPercent: 17, windowDurationMins: 300 },
    ]);
  }
});

test('Codex reconciles the legacy account view before naming same-duration slots', () => {
  const primary = { usedPercent: 40, windowDurationMins: 300 };
  const secondary = { usedPercent: 10, windowDurationMins: 300 };
  for (const [accountView, mapped] of [
    [{ primary }, { primary, secondary }],
    [{ primary, secondary }, { primary }],
    [{ primary, secondary }, { secondary }],
  ]) {
    const windows = codexPlanWindows({
      rateLimits: { ...accountView, limitId: null },
      rateLimitsByLimitId: { codex: mapped },
    });
    expect(windows).toEqual([
      { name: 'codex:300m:primary', usedPercent: 40, windowDurationMins: 300 },
      { name: 'codex:300m:secondary', usedPercent: 10, windowDurationMins: 300 },
    ]);
  }
  expect(
    codexPlanWindows({
      rateLimits: { primary },
      rateLimitsByLimitId: { codex: { secondary: primary } },
    }),
  ).toEqual([{ name: 'codex:300m', usedPercent: 40, windowDurationMins: 300 }]);
});

test('Codex preserves bucket label, resetsAt, and partial durations in both directions without collapsing distinct windows', () => {
  const resets = '2026-12-01T00:00:00.000Z';
  const newerResets = '2026-12-08T00:00:00.000Z';

  // Missing or null label/resetsAt in rateLimitsByLimitId.codex keeps values from rateLimits,
  // including when usedPercent updates to 0 and across a sibling secondary slot.
  for (const mapped of [
    {
      limitId: 'codex',
      primary: { usedPercent: 0, windowDurationMins: 10_080 },
      secondary: { usedPercent: 12, windowDurationMins: 300 },
    },
    {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: null },
      secondary: { usedPercent: 12, windowDurationMins: 300 },
    },
  ]) {
    expect(
      codexPlanLimits({
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex Account',
          planType: 'pro',
          primary: { usedPercent: 91, windowDurationMins: 10_080, resetsAt: resets },
        },
        rateLimitsByLimitId: { codex: mapped },
      }),
    ).toMatchObject({
      answer: 'known',
      plan: 'pro',
      windows: [
        {
          name: 'codex:10080m',
          usedPercent: 0,
          windowDurationMins: 10_080,
          resetsAt: resets,
          label: 'Codex Account',
        },
        {
          name: 'codex:300m',
          usedPercent: 12,
          windowDurationMins: 300,
          label: 'Codex Account',
        },
      ],
    });
  }

  // Explicit label/resetsAt in rateLimitsByLimitId.codex updates the whole bucket cleanly
  // (no split-brain label across sibling slots), and also applies when rateLimits carried label only.
  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Old Label',
        primary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: resets },
        secondary: { usedPercent: 20, windowDurationMins: 300 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'New Label',
          primary: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: newerResets },
        },
      },
    }),
  ).toEqual([
    {
      name: 'codex:10080m',
      usedPercent: 55,
      windowDurationMins: 10_080,
      resetsAt: newerResets,
      label: 'New Label',
    },
    {
      name: 'codex:300m',
      usedPercent: 20,
      windowDurationMins: 300,
      label: 'New Label',
    },
  ]);

  expect(
    codexPlanWindows({
      rateLimits: { limitId: 'codex', limitName: 'Header Only', primary: null },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 15, windowDurationMins: 300 } },
      },
    }),
  ).toEqual([
    { name: 'codex:300m', usedPercent: 15, windowDurationMins: 300, label: 'Header Only' },
  ]);

  // Partial windowDurationMins in either order reconciles into one window without duplicates.
  for (const [firstView, secondView] of [
    [
      { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: resets } },
      { primary: { usedPercent: 60 } },
    ],
    [
      { primary: { usedPercent: 50, resetsAt: resets } },
      { primary: { usedPercent: 60, windowDurationMins: 300 } },
    ],
  ]) {
    expect(
      codexPlanWindows({
        rateLimits: { limitId: 'codex', ...firstView },
        rateLimitsByLimitId: { codex: secondView },
      }),
    ).toEqual([
      { name: 'codex:300m', usedPercent: 60, windowDurationMins: 300, resetsAt: resets },
    ]);
  }

  // Same-duration pair with omitted duration in one view preserves both slots in either order.
  const fullPair = {
    primary: { usedPercent: 40, windowDurationMins: 300 },
    secondary: { usedPercent: 10, windowDurationMins: 300 },
  };
  const partialPair = { primary: { usedPercent: 40 }, secondary: { usedPercent: 10 } };
  for (const [firstView, secondView] of [
    [fullPair, partialPair],
    [partialPair, fullPair],
  ]) {
    expect(
      codexPlanWindows({
        rateLimits: { limitId: 'codex', ...firstView },
        rateLimitsByLimitId: { codex: secondView },
      }),
    ).toEqual([
      { name: 'codex:300m:primary', usedPercent: 40, windowDurationMins: 300 },
      { name: 'codex:300m:secondary', usedPercent: 10, windowDurationMins: 300 },
    ]);
  }

  // Negative anti-collapse controls: unknown duration never crosses slots, and two distinct known
  // durations in the same slot stay distinct.
  expect(
    codexPlanWindows({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 40 } },
      rateLimitsByLimitId: {
        codex: { secondary: { usedPercent: 10, windowDurationMins: 10_080 } },
      },
    }),
  ).toEqual([
    { name: 'codex:primary', usedPercent: 40 },
    { name: 'codex:10080m', usedPercent: 10, windowDurationMins: 10_080 },
  ]);

  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40 },
        secondary: { usedPercent: 10, windowDurationMins: 300 },
      },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 45, windowDurationMins: 300 } },
      },
    }),
  ).toEqual([
    { name: 'codex:300m:primary', usedPercent: 45, windowDurationMins: 300 },
    { name: 'codex:300m:secondary', usedPercent: 10, windowDurationMins: 300 },
  ]);

  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 10_080 },
      },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 15, windowDurationMins: 300 } },
      },
    }),
  ).toEqual([
    { name: 'codex:10080m', usedPercent: 40, windowDurationMins: 10_080 },
    { name: 'codex:300m', usedPercent: 15, windowDurationMins: 300 },
  ]);
});

test('Codex never collapses sibling slots when inheriting partial duration, whitespace labels, zero resetsAt, or ambiguous partials', () => {
  const resets = '2026-12-01T00:00:00.000Z';

  // Whitespace limitName and resetsAt: 0 in a duplicate view keep previously measured metadata,
  // and slot swap preserves resetsAt on the moved window.
  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex Account',
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: resets },
      },
      rateLimitsByLimitId: {
        codex: {
          limitName: '   ',
          secondary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 0 },
        },
      },
    }),
  ).toEqual([
    {
      name: 'codex:300m',
      usedPercent: 45,
      windowDurationMins: 300,
      resetsAt: resets,
      label: 'Codex Account',
    },
  ]);

  // Partial primary inheriting 300m must not be overwritten by secondary(300m) in the same snapshot,
  // and conversely primary(300m) must not steal secondary's window when secondary omits duration.
  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: resets },
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 45 },
          secondary: { usedPercent: 10, windowDurationMins: 300 },
        },
      },
    }),
  ).toEqual([
    {
      name: 'codex:300m:primary',
      usedPercent: 45,
      windowDurationMins: 300,
      resetsAt: resets,
    },
    { name: 'codex:300m:secondary', usedPercent: 10, windowDurationMins: 300 },
  ]);

  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: resets },
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 45, windowDurationMins: 300 },
          secondary: { usedPercent: 15 },
        },
      },
    }),
  ).toEqual([
    {
      name: 'codex:300m:secondary',
      usedPercent: 15,
      windowDurationMins: 300,
      resetsAt: resets,
    },
    { name: 'codex:300m:primary', usedPercent: 45, windowDurationMins: 300 },
  ]);

  // Distinct existing secondary(10080m) stays intact when partial primary inherits 300m alongside new secondary(300m).
  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 300 },
        secondary: { usedPercent: 20, windowDurationMins: 10_080 },
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 45 },
          secondary: { usedPercent: 10, windowDurationMins: 300 },
        },
      },
    }),
  ).toEqual([
    { name: 'codex:300m:primary', usedPercent: 45, windowDurationMins: 300 },
    { name: 'codex:10080m', usedPercent: 20, windowDurationMins: 10_080 },
    { name: 'codex:300m:secondary', usedPercent: 10, windowDurationMins: 300 },
  ]);

  // Same-duration pair with only one slot omitting duration in the second view updates both slots cleanly.
  for (const mapped of [
    { primary: { usedPercent: 45 }, secondary: { usedPercent: 12, windowDurationMins: 300 } },
    { primary: { usedPercent: 45, windowDurationMins: 300 }, secondary: { usedPercent: 12 } },
  ]) {
    expect(
      codexPlanWindows({
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 40, windowDurationMins: 300 },
          secondary: { usedPercent: 10, windowDurationMins: 300 },
        },
        rateLimitsByLimitId: { codex: mapped },
      }),
    ).toEqual([
      { name: 'codex:300m:primary', usedPercent: 45, windowDurationMins: 300 },
      { name: 'codex:300m:secondary', usedPercent: 12, windowDurationMins: 300 },
    ]);
  }

  // Ambiguous partial (two existing windows in the same slot with different known durations) appends
  // a fallback slot window instead of overwriting either known-duration window.
  expect(
    codexPlanWindows({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 10_080 },
      },
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 15, windowDurationMins: 300 } },
        extra: { limitId: 'codex', primary: { usedPercent: 25 } },
      },
    }),
  ).toEqual([
    { name: 'codex:10080m', usedPercent: 40, windowDurationMins: 10_080 },
    { name: 'codex:300m', usedPercent: 15, windowDurationMins: 300 },
    { name: 'codex:primary', usedPercent: 25 },
  ]);
});

test('both Claude usage entrypoints retain measured model windows and scope only named models', () => {
  const buckets = {
    five_hour: { utilization: 10 },
    model_scoped: [
      { display_name: ' Fable ', utilization: 49 },
      { display_name: '  ', utilization: 0 },
      { display_name: null, utilization: 8 },
      { utilization: null },
    ],
  };
  for (const read of [cliUsage, sdkUsage]) {
    for (const raw of [buckets, { rate_limits: buckets }]) {
      const { answer, windows } = read(raw);
      expect(answer).toBe('known');
      expect(windows).toHaveLength(4);
      expect(windows[0]).toEqual({ name: 'five_hour', usedPercent: 10 });
      expect(windows[1]).toEqual({
        name: 'model:Fable',
        usedPercent: 49,
        label: 'Fable',
        scope: 'Fable',
      });
      for (const [index, usedPercent] of [0, 8].entries()) {
        const window = windows[index + 2];
        expect(window?.usedPercent).toBe(usedPercent);
        expect(window).not.toHaveProperty('scope');
        expect(window).not.toHaveProperty('label');
      }
      expect(new Set(windows.map((window) => window.name)).size).toBe(4);
    }
  }
});

test('Codex quota pushes past the window cap truncate instead of refusing the update', () => {
  const book = new CodexLimitBook();
  const now = new Date('2026-11-27T12:00:00Z');
  const buckets = (from: number, count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `b${String(from + index).padStart(2, '0')}`,
        {
          limitId: `b${String(from + index).padStart(2, '0')}`,
          primary: { usedPercent: 1, windowDurationMins: 300 },
          secondary: { usedPercent: 2, windowDurationMins: 10_080 },
        },
      ]),
    );
  book.replace('p', { rateLimits: account, rateLimitsByLimitId: buckets(0, 15) }, now);
  // Before the fix, merging these by name past 32 windows threw `too_big` and lost the update.
  const pushed = book.update('p', { rateLimitsByLimitId: buckets(15, 10) }, now);
  expect(pushed.windows.length).toBeLessThanOrEqual(32);
  expect(pushed.windows.find((window) => window.name === 'codex:10080m')?.usedPercent).toBe(
    91,
  );
  // A second push for a known bucket updates its windows, it adds none.
  const again = book.update(
    'p',
    { rateLimits: { limitId: 'codex', primary: { usedPercent: 92 } } },
    now,
  );
  expect(again.windows.length).toBe(pushed.windows.length);
  expect(again.windows.find((window) => window.name === 'codex:10080m')?.usedPercent).toBe(92);
});
