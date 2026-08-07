/**
 * Tool names must be derivable to something a provider accepts, and an
 * undeliverable name must fail at mount rather than in production. → ADR 0035.
 *
 * Nothing else *stops* it: the MCP SDK warns (SEP-986) but registers anyway, and
 * the `ai` SDK has no rule at all — so an illegal name reaches the provider, which
 * rejects the whole request and takes every tool of that mount down with it. The
 * CLI is deliberately exempt: its names go to a shell, not to a provider.
 */

import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { mountAgent } from '../src/tools/agent';
import { createCli } from '../src/tools/cli';
import { listToolNames } from '../src/tools/list-names';
import { mountMcp, validateMcpSchemas } from '../src/tools/mcp';
import { collectTools } from '../src/tools/mount';
import { toToolName } from '../src/tools/names';
import { summarizeTransports } from '../src/tools/transports';

const PROVIDER_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** A one-endpoint service under an arbitrary prefix. */
function serviceWith(prefix: string, toolName?: string) {
  const contract = defineContract(
    { prefix },
    {
      get: {
        method: 'GET',
        path: '/',
        desc: 'Get a thing',
        ...(toolName ? { toolName } : {}),
        output: z.object({ ok: z.boolean() }),
      },
    },
  );
  return implement(contract, { get: () => ({ ok: true }) });
}

describe('toToolName — normalisation', () => {
  const derived: Array<[string, string, string]> = [
    ['admin/analytics', 'overview', 'overview_admin_analytics'],
    ['admin/analytics', 'get', 'get_admin_analytics'],
    ['client/events', 'track', 'track_client_event'],
    ['admin.chat', 'list', 'list_admin_chat'],
    ['my service', 'get', 'get_my_service'],
    // The method half is an object key, and a runtime-built contract bypasses
    // the type — so it is normalised too.
    ['users', 'user.profile', 'user_profile_user'],
  ];

  for (const [prefix, method, expected] of derived) {
    test(`${prefix} · ${method} → ${expected}`, () => {
      const name = toToolName(prefix, method);
      expect(name).toBe(expected);
      expect(PROVIDER_RE.test(name)).toBe(true);
    });
  }

  test('a leading digit is legal — it is not a rejection case', () => {
    expect(toToolName('2fa', 'get')).toBe('get_2fa');
    expect(PROVIDER_RE.test('get_2fa')).toBe(true);
  });

  test('a hyphenated METHOD key keeps its hyphen — it was legal and shipped', () => {
    // The half the change newly normalises. `-` is inside the accepted charset, so
    // `get-user_note` worked and may be pinned in a client config; only genuinely
    // undeliverable characters move.
    expect(toToolName('notes', 'get-user')).toBe('get-user_note');
    expect(toToolName('notes', 'sync-all')).toBe('sync-all_note');
    // …but a character no provider accepts still normalises.
    expect(toToolName('notes', 'get.user')).toBe('get_user_note');
  });

  test('names that are legal today are byte-identical — no collapsing, no trimming', () => {
    // Collapsing runs or trimming `_` would rename these for pure cosmetics.
    expect(toToolName('_internal', 'get')).toBe('get__internal');
    expect(toToolName('a__b', 'get')).toBe('get_a__b');
    expect(toToolName('foo-', 'get')).toBe('get_foo_');
    expect(toToolName('my__service', 'get')).toBe('get_my__service');
    expect(toToolName('user-profiles', 'get')).toBe('get_user_profile');
    expect(toToolName('users', 'list')).toBe('list_users');
  });
});

describe('toToolName — singularize applies to the last segment', () => {
  // Comparing SINGULAR_EXCEPTIONS against the whole name only ever matched an
  // unprefixed service, so a prefixed one was mangled. These are renames, and
  // the CHANGELOG lists them as breaking.
  const fixed: Array<[string, string, string]> = [
    ['bot-status', 'get', 'get_bot_status'],
    ['user-settings', 'get', 'get_user_settings'],
    ['chat-analytics', 'get', 'get_chat_analytics'],
    ['site-news', 'get', 'get_site_news'],
  ];
  for (const [prefix, method, expected] of fixed) {
    test(`${prefix} · ${method} → ${expected}`, () => {
      expect(toToolName(prefix, method)).toBe(expected);
    });
  }

  test('an unprefixed exception still works', () => {
    expect(toToolName('analytics', 'get')).toBe('get_analytics');
    expect(toToolName('status', 'get')).toBe('get_status');
  });
});

describe('mount-time assertion', () => {
  test('an explicit toolName outside the charset throws, naming the endpoint', () => {
    expect(() => collectTools(serviceWith('notes', 'bad/name'), 'MCP')).toThrow(
      /Tool name "bad\/name".*service "notes".*must match/,
    );
  });

  test('an over-long name throws and points at the remedy', () => {
    expect(() => collectTools(serviceWith('notes', 'x'.repeat(65)), 'MCP')).toThrow(
      /65 characters \(max 64\).*toolName/,
    );
  });

  test('a prefix with no usable characters throws instead of shipping "get_"', () => {
    // `///` normalises to separators; the resulting `get_` PASSES the charset
    // check while being meaningless and identical for every such service.
    expect(() => collectTools(serviceWith('///'), 'MCP')).toThrow(
      /has no characters usable in a tool name/,
    );
    expect(() => collectTools(serviceWith('日本語'), 'MCP')).toThrow(
      /has no characters usable in a tool name/,
    );
  });

  test('a legal name mounts unchanged', () => {
    const [tool] = collectTools(serviceWith('admin/analytics'), 'MCP');
    expect(tool?.name).toBe('get_admin_analytics');
  });

  test('every provider-facing mount enforces it — MCP, agent and the build probe', () => {
    const bad = serviceWith('notes', 'bad name');
    expect(() => mountMcp(new McpServer({ name: 't', version: '1' }), bad)).toThrow(
      /Tool name "bad name"/,
    );
    expect(() => mountAgent(bad)).toThrow(/Tool name "bad name"/);
    expect(() => validateMcpSchemas({ services: [bad] })).toThrow(/Tool name "bad name"/);
  });
});

describe('read-only diagnostics never refuse', () => {
  test('summarizeTransports counts an illegal name instead of throwing', () => {
    // A boot summary that dies would hide the very diagnostic the upgrade guide
    // points at.
    const totals = summarizeTransports([serviceWith('notes', 'bad/name')]);
    expect(totals.totals.MCP).toBe(1);
  });

  test('the CLI is exempt — its names are typed into a shell, not sent to a provider', () => {
    const cyrillic = implement(
      defineContract(
        { prefix: 'поиск' },
        {
          run: {
            method: 'POST',
            path: '/',
            desc: 'Run a search',
            expose: ['CLI'],
            output: z.object({ ok: z.boolean() }),
          },
        },
      ),
      { run: () => ({ ok: true }) },
    );
    expect(() => collectTools(cyrillic, 'CLI')).not.toThrow();
  });
});

describe('listToolNames stays a diagnostic', () => {
  test('it reports an illegal name instead of throwing', () => {
    // The guide points a migrating consumer at this lister to find the offending
    // name. If it threw, the diagnostic would die on the very case it exists for.
    const names = listToolNames([serviceWith('notes', 'bad/name')]);
    expect(names.map((n) => n.name)).toEqual(['bad/name']);
    expect(names[0]?.transports).toContain('MCP');
  });

  test('it still resolves normalised derived names', () => {
    expect(listToolNames([serviceWith('admin/analytics')])[0]?.name).toBe(
      'get_admin_analytics',
    );
  });
});

describe('one duplicate guard, three surfaces', () => {
  // ADR 0035 declines to add a collision check of its own *because* all three
  // mounts already dedupe. That makes the guarantee load-bearing documentation,
  // so it now runs through one helper — and each surface keeps its own wording.
  test('every mount reports a duplicate, each with its own label', () => {
    const a = serviceWith('notes');
    const b = serviceWith('notes');
    expect(() => mountAgent([a, b])).toThrow(
      'Duplicate agent tool name "get_note" across mounted services',
    );
    expect(() => validateMcpSchemas({ services: [a, b] })).toThrow(
      'Duplicate MCP tool name "get_note" across mounted services',
    );
    const cli = (prefix: string) =>
      implement(
        defineContract(
          { prefix },
          {
            get: {
              method: 'GET',
              path: '/',
              desc: 'Get',
              expose: ['CLI'],
              output: z.object({ ok: z.boolean() }),
            },
          },
        ),
        { get: () => ({ ok: true }) },
      );
    expect(() =>
      createCli({ name: 'x', version: '1', services: [cli('notes'), cli('notes')] }),
    ).toThrow('Duplicate CLI command "get_note" across mounted services');
  });
});

describe('the existing duplicate guards fire on merged names', () => {
  test('two prefixes normalising to the same name collide at mount', () => {
    // `admin/chat` and `admin.chat` both normalise to `admin_chat`. No new check
    // was added for this — the mounts already dedupe across services.
    const a = serviceWith('admin/chat');
    const b = serviceWith('admin.chat');
    expect(() => mountAgent([a, b])).toThrow(/Duplicate agent tool name "get_admin_chat"/);
    expect(() => validateMcpSchemas({ services: [a, b] })).toThrow(
      /Duplicate MCP tool name "get_admin_chat"/,
    );
  });
});
