/**
 * ACP session `_meta` exposure regressions: `probeCapabilities` (`session/new`) and `open`
 * (`session/new`, `session/resume`, `session/load`) preserve plain-object `_meta` in `sessionMeta`
 * and ignore absent or non-object `_meta` without failing schema parsing.
 */
import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { ambientIn, inScratch, trackedPidFile } from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

const TIER_META = {
  provider: {
    tier: {
      name: 'Ultra Plan',
      id: 'ultra-tier',
      upgradeUri: 'https://example.invalid/upgrade',
    },
  },
};

const RESUME_META = {
  provider: {
    tier: { name: 'Resumed Tier', id: 'resumed-tier' },
    reopenedVia: 'resume',
  },
};

const LOAD_META = {
  provider: {
    tier: { name: 'Loaded Tier', id: 'loaded-tier' },
    reopenedVia: 'load',
  },
};

interface MetaAgentOptions {
  readonly supportsResume?: boolean;
  readonly newMeta?: unknown;
  readonly hasNewMeta?: boolean;
  readonly resumeMeta?: unknown;
  readonly hasResumeMeta?: boolean;
  readonly loadMeta?: unknown;
  readonly hasLoadMeta?: boolean;
}

async function writeMetaAcpAgent(
  root: string,
  name: string,
  options: MetaAgentOptions,
): Promise<string> {
  const scriptPath = join(root, `${name}.mjs`);
  const config = JSON.stringify({
    supportsResume: options.supportsResume ?? false,
    hasNewMeta: options.hasNewMeta ?? false,
    newMeta: options.newMeta ?? null,
    hasResumeMeta: options.hasResumeMeta ?? false,
    resumeMeta: options.resumeMeta ?? null,
    hasLoadMeta: options.hasLoadMeta ?? false,
    loadMeta: options.loadMeta ?? null,
  });
  const source = [
    `import { mkdirSync, writeFileSync } from 'node:fs';`,
    `import { dirname } from 'node:path';`,
    `import { createInterface } from 'node:readline';`,
    'if (process.env.FAKE_ENGINE_PID_FILE) {',
    '  mkdirSync(dirname(process.env.FAKE_ENGINE_PID_FILE), { recursive: true });',
    '  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, String(process.pid));',
    '}',
    `const cfg = ${config};`,
    `const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');`,
    'const configOptions = [',
    `  { id: 'model', name: 'Model', category: 'model', currentValue: 'm-1', options: [{ value: 'm-1', name: 'Model 1' }] },`,
    '];',
    'for await (const line of createInterface({ input: process.stdin })) {',
    '  const msg = JSON.parse(line);',
    '  if (msg.id === undefined) continue;',
    `  if (msg.method === 'initialize') {`,
    '    write({',
    '      id: msg.id,',
    '      result: {',
    '        protocolVersion: 1,',
    '        agentCapabilities: {',
    '          loadSession: true,',
    '          sessionCapabilities: {',
    '            load: {},',
    '            close: {},',
    '            delete: {},',
    '            ...(cfg.supportsResume ? { resume: {} } : {}),',
    '          },',
    '          _meta: { provider: { tier: true } },',
    '        },',
    `        agentInfo: { name: 'meta-agent', version: '1.5.18' },`,
    '      },',
    '    });',
    `  } else if (msg.method === 'session/new') {`,
    '    write({',
    `      method: 'session/update',`,
    '      params: {',
    `        sessionId: 'sess-new-1',`,
    '        update: {',
    `          sessionUpdate: 'available_commands_update',`,
    `          availableCommands: [{ name: 'status' }],`,
    '        },',
    '      },',
    '    });',
    '    write({',
    '      id: msg.id,',
    '      result: {',
    `        sessionId: 'sess-new-1',`,
    '        configOptions,',
    '        ...(cfg.hasNewMeta ? { _meta: cfg.newMeta } : {}),',
    '      },',
    '    });',
    `  } else if (msg.method === 'session/resume') {`,
    '    write({',
    '      id: msg.id,',
    '      result: {',
    '        configOptions,',
    '        ...(cfg.hasResumeMeta ? { _meta: cfg.resumeMeta } : {}),',
    '      },',
    '    });',
    `  } else if (msg.method === 'session/load') {`,
    '    write({',
    '      id: msg.id,',
    '      result: {',
    '        configOptions,',
    '        ...(cfg.hasLoadMeta ? { _meta: cfg.loadMeta } : {}),',
    '      },',
    '    });',
    `  } else if (msg.method === 'session/set_config_option') {`,
    '    write({ id: msg.id, result: { configOptions } });',
    `  } else if (msg.method === 'session/close' || msg.method === 'session/delete') {`,
    '    write({ id: msg.id, result: {} });',
    '  }',
    '}',
  ].join('\n');
  await writeFile(scriptPath, source);
  return scriptPath;
}

function makeProfile(root: string, label: string) {
  return {
    profileId: label,
    engine: 'acp' as const,
    home: join(root, `home-${label}`),
    env: { FAKE_ENGINE_PID_FILE: trackedPidFile(root, label) },
  };
}

describe('ACP sessionMeta exposure on probeCapabilities and open', () => {
  test('probeCapabilities returns sessionMeta from session/new alongside existing probe fields and omits it when absent', () =>
    inScratch('acp-probe-session-meta', async (root) => {
      const withMetaScript = await writeMetaAcpAgent(root, 'probe-with-meta', {
        hasNewMeta: true,
        newMeta: TIER_META,
      });
      const driverWithMeta = createAcpDriver({
        executable: process.execPath,
        args: [withMetaScript],
        ambient: ambientIn(root),
      });

      const probe = await driverWithMeta.probeCapabilities({
        profile: makeProfile(root, 'probe-with-meta'),
        cwd: root,
      });
      expect(probe.sessionMeta).toEqual(TIER_META);
      expect(probe.initialized.agentInfo).toMatchObject({
        name: 'meta-agent',
        version: '1.5.18',
      });
      expect(probe.models).toEqual(['m-1']);
      expect(probe.commands).toEqual(['status']);
      expect(probe.configOptions.map((option) => option.id)).toEqual(['model']);

      const probeEachModel = await driverWithMeta.probeCapabilities({
        profile: makeProfile(root, 'probe-each-model-meta'),
        cwd: root,
        eachModel: true,
      });
      expect(probeEachModel.sessionMeta).toEqual(TIER_META);
      expect(probeEachModel.optionsByModel?.['m-1']?.map((option) => option.id)).toEqual([
        'model',
      ]);

      const emptyMetaScript = await writeMetaAcpAgent(root, 'probe-empty-meta', {
        hasNewMeta: true,
        newMeta: {},
      });
      const emptyProbe = await createAcpDriver({
        executable: process.execPath,
        args: [emptyMetaScript],
        ambient: ambientIn(root),
      }).probeCapabilities({
        profile: makeProfile(root, 'probe-empty-meta'),
        cwd: root,
      });
      expect(emptyProbe.sessionMeta).toEqual({});

      const withoutMetaScript = await writeMetaAcpAgent(root, 'probe-without-meta', {});
      const withoutProbe = await createAcpDriver({
        executable: process.execPath,
        args: [withoutMetaScript],
        ambient: ambientIn(root),
      }).probeCapabilities({
        profile: makeProfile(root, 'probe-without-meta'),
        cwd: root,
      });
      expect(withoutProbe.sessionMeta).toBeUndefined();
      expect('sessionMeta' in withoutProbe).toBe(false);
    }));

  test('open populates session.sessionMeta from session/new, session/resume, and session/load', () =>
    inScratch('acp-open-session-meta', async (root) => {
      const resumeAgent = await writeMetaAcpAgent(root, 'open-resume-meta', {
        supportsResume: true,
        hasNewMeta: true,
        newMeta: TIER_META,
        hasResumeMeta: true,
        resumeMeta: RESUME_META,
      });
      const resumeDriver = createAcpDriver({
        executable: process.execPath,
        args: [resumeAgent],
        ambient: ambientIn(root),
      });

      const created = await resumeDriver.open({
        profile: makeProfile(root, 'open-create'),
        cwd: root,
      });
      try {
        expect(created.nativeThreadId).toBe('sess-new-1');
        expect(created.sessionMeta).toEqual(TIER_META);
      } finally {
        await created.close();
      }

      const resumed = await resumeDriver.open({
        profile: makeProfile(root, 'open-resume'),
        cwd: root,
        nativeThreadId: 'sess-existing-1',
      });
      try {
        expect(resumed.nativeThreadId).toBe('sess-existing-1');
        expect(resumed.sessionMeta).toEqual(RESUME_META);
      } finally {
        await resumed.close();
      }

      const loadAgent = await writeMetaAcpAgent(root, 'open-load-meta', {
        supportsResume: false,
        hasLoadMeta: true,
        loadMeta: LOAD_META,
      });
      const loaded = await createAcpDriver({
        executable: process.execPath,
        args: [loadAgent],
        ambient: ambientIn(root),
      }).open({
        profile: makeProfile(root, 'open-load'),
        cwd: root,
        nativeThreadId: 'sess-existing-2',
      });
      try {
        expect(loaded.nativeThreadId).toBe('sess-existing-2');
        expect(loaded.sessionMeta).toEqual(LOAD_META);
      } finally {
        await loaded.close();
      }
    }));

  test.each([
    ['absent', false, undefined],
    ['null', true, null],
    ['string', true, 'not-an-object'],
    ['number', true, 42],
    ['boolean', true, true],
    ['array', true, ['not', 'a', 'record']],
  ] as const)(
    'non-object or absent _meta (%s) does not fail parsing and yields undefined sessionMeta across probe, create, resume, and load',
    (label, hasMeta, metaValue) =>
      inScratch(`acp-invalid-meta-${label}`, async (root) => {
        const resumeScript = await writeMetaAcpAgent(root, `invalid-resume-${label}`, {
          supportsResume: true,
          hasNewMeta: hasMeta,
          newMeta: metaValue,
          hasResumeMeta: hasMeta,
          resumeMeta: metaValue,
        });
        const resumeDriver = createAcpDriver({
          executable: process.execPath,
          args: [resumeScript],
          ambient: ambientIn(root),
        });

        const probe = await resumeDriver.probeCapabilities({
          profile: makeProfile(root, `probe-${label}`),
          cwd: root,
        });
        expect(probe.sessionMeta).toBeUndefined();
        expect('sessionMeta' in probe).toBe(false);

        const created = await resumeDriver.open({
          profile: makeProfile(root, `create-${label}`),
          cwd: root,
        });
        try {
          expect(created.sessionMeta).toBeUndefined();
          expect('sessionMeta' in created).toBe(false);
        } finally {
          await created.close();
        }

        const resumed = await resumeDriver.open({
          profile: makeProfile(root, `resume-${label}`),
          cwd: root,
          nativeThreadId: 'sess-keep',
        });
        try {
          expect(resumed.sessionMeta).toBeUndefined();
          expect('sessionMeta' in resumed).toBe(false);
        } finally {
          await resumed.close();
        }

        const loadScript = await writeMetaAcpAgent(root, `invalid-load-${label}`, {
          supportsResume: false,
          hasLoadMeta: hasMeta,
          loadMeta: metaValue,
        });
        const loaded = await createAcpDriver({
          executable: process.execPath,
          args: [loadScript],
          ambient: ambientIn(root),
        }).open({
          profile: makeProfile(root, `load-${label}`),
          cwd: root,
          nativeThreadId: 'sess-keep',
        });
        try {
          expect(loaded.sessionMeta).toBeUndefined();
          expect('sessionMeta' in loaded).toBe(false);
        } finally {
          await loaded.close();
        }
      }),
  );
});
