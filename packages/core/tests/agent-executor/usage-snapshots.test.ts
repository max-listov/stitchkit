import { expect, test } from 'bun:test';
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
