import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertAllowedOptionalPackages,
  assertExportCoverage,
  assertMissingPeerDiagnostic,
  OPTIONAL_PEER_MATRIX,
} from '../scripts/consumer-lane/optional-peer-matrix.mjs';

describe('optional peer matrix', () => {
  test('classifies every current public export', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(() => assertExportCoverage(manifest.exports)).not.toThrow();
    expect(new Set(OPTIONAL_PEER_MATRIX.map((entry) => entry.subpath)).size).toBe(
      Object.keys(manifest.exports).length,
    );
  });

  test('runtime budget failure names the case and forbidden package', () => {
    expect(() =>
      assertAllowedOptionalPackages({
        caseName: 'neutral-runtime',
        kind: 'runtime',
        observed: ['grammy'],
        allowed: [],
      }),
    ).toThrow('neutral-runtime: forbidden runtime package grammy');
  });

  test('declaration budget failure names the case and forbidden type-only package', () => {
    expect(() =>
      assertAllowedOptionalPackages({
        caseName: 'neutral-types',
        kind: 'declaration',
        observed: ['@modelcontextprotocol/server'],
        allowed: [],
      }),
    ).toThrow('neutral-types: forbidden declaration package @modelcontextprotocol/server');
  });

  test('a feature with two absent runtime peers accepts whichever package Node resolves first', () => {
    const expectation = {
      caseName: 'tools-mcp-feature',
      expected: ['Cannot find package'],
      expectedAny: ["'ai'", "'@modelcontextprotocol/server'"],
    };
    expect(() =>
      assertMissingPeerDiagnostic({
        ...expectation,
        result: {
          failed: true,
          output: "Cannot find package '@modelcontextprotocol/server' imported from tools.js",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertMissingPeerDiagnostic({
        ...expectation,
        result: { failed: true, output: "Cannot find package 'unrelated-peer'" },
      }),
    ).toThrow('tools-mcp-feature: missing-peer diagnostic mismatch');
  });
});
