import assert from 'node:assert/strict';
import { join } from 'node:path';
import { engineEnvironment } from 'stitchkit/agent-executor';
import { claudeUsagePlanLimits as cliUsage } from 'stitchkit/agent-executor/claude';
import {
  createClaudeSdkDriver,
  claudeUsagePlanLimits as sdkUsage,
} from 'stitchkit/agent-executor/claude-sdk';
import { codexPlanLimits } from 'stitchkit/agent-executor/codex';
import { createFakeClaudeSdkQuery } from 'stitchkit/agent-executor/testing/claude-sdk';

const account = {
  limitId: 'codex',
  planType: 'pro',
  primary: { usedPercent: 91, windowDurationMins: 10080 },
};
const model = { primary: { usedPercent: 6, windowDurationMins: 300 } };
for (const raw of [
  { ...account, rateLimitsByLimitId: { model } },
  { rateLimits: account, rateLimitsByLimitId: { codex: account, model } },
]) {
  const result = codexPlanLimits(raw);
  assert.equal(result.plan, 'pro');
  assert.deepEqual(
    result.windows.map((w) => [w.name, w.usedPercent]),
    [
      ['codex:10080m', 91],
      ['model:300m', 6],
    ],
  );
}
const rate_limits = {
  five_hour: { utilization: 10 },
  model_scoped: [{ display_name: 'Fable', utilization: 49 }],
};
for (const read of [cliUsage, sdkUsage]) {
  assert.deepEqual(read({ rate_limits }).windows, [
    { name: 'five_hour', usedPercent: 10 },
    { name: 'model:Fable', usedPercent: 49, label: 'Fable', scope: 'Fable' },
  ]);
}

const home = join(process.cwd(), '.claude');
const ambient = { HOME: process.cwd(), CLAUDE_CONFIG_DIR: join(process.cwd(), 'unselected') };
const fake = createFakeClaudeSdkQuery();
const seen = [];
const sdk = createClaudeSdkDriver({
  ambient,
  sdkVersion: 'test',
  query(args) {
    assert(args.options.env);
    seen.push(args.options.env);
    return fake.query(args);
  },
});
for (const mode of [{ claudeConfigDir: 'default' }, {}]) {
  const profile = { engine: 'claude-sdk', profileId: 'test', home, ...mode };
  await sdk.probeCapabilities({ profile, cwd: process.cwd() });
  const expected =
    'claudeConfigDir' in mode
      ? { HOME: ambient.HOME }
      : { HOME: ambient.HOME, CLAUDE_CONFIG_DIR: home };
  assert.deepEqual(seen.shift(), expected);
  assert.deepEqual(engineEnvironment({ ...profile, engine: 'claude-cli' }, ambient), expected);
}
console.log('packed executor profile and usage: ok');
