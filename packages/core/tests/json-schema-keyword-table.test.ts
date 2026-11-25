/**
 * Completeness and behavioural verification of the single JSON Schema keyword
 * table (`JSON_SCHEMA_KEYWORDS`) across MCP and OpenAPI 3.0/3.1 connection paths.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import ts from '@typescript/typescript6';
import { createCli } from '../src/entrypoints/cli';
import {
  defineMcpClientConnection,
  defineOpenApiConnection,
  mountConnections,
  type SkippedConnectionTool,
} from '../src/entrypoints/tools/connections';
import { isRecord } from '../src/internal/typed';
import { withDraft2020Keywords } from '../src/json-schema/dialect';
import {
  JSON_SCHEMA_KEYWORDS,
  type KeywordRow,
  lookupJsonSchemaKeyword,
} from '../src/json-schema/keywords';
import { withServedFormats } from '../src/json-schema/string-format';
import {
  zodObjectFromJsonSchema,
  zodOutputFromJsonSchema,
} from '../src/tools/connections/runtime';
import { buildMcpServer } from '../src/tools/mcp/mount';
import type { RuntimeToolDefinition } from '../src/tools/runtime-tool';
import { localVerdict } from '../src/tools/schema/json-schema-origin';
import {
  buildToolPresentationSchema,
  isObjectPresentationSchema,
} from '../src/tools/schema/presentation';

/** Canonical vocabulary inventories from draft-07, 2020-12 and OpenAPI 3.0 Schema Object. */
const VOCABULARY_INVENTORY = {
  draft07: [
    '$schema',
    '$id',
    '$ref',
    'definitions',
    '$comment',
    'type',
    'enum',
    'const',
    'multipleOf',
    'maximum',
    'exclusiveMaximum',
    'minimum',
    'exclusiveMinimum',
    'maxLength',
    'minLength',
    'pattern',
    'items',
    'additionalItems',
    'maxItems',
    'minItems',
    'uniqueItems',
    'contains',
    'maxProperties',
    'minProperties',
    'required',
    'properties',
    'patternProperties',
    'additionalProperties',
    'dependencies',
    'propertyNames',
    'if',
    'then',
    'else',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'format',
    'contentMediaType',
    'contentEncoding',
    'title',
    'description',
    'default',
    'readOnly',
    'writeOnly',
    'examples',
  ],
  draft202012: [
    '$schema',
    '$id',
    '$ref',
    '$defs',
    '$anchor',
    '$dynamicRef',
    '$dynamicAnchor',
    '$vocabulary',
    '$comment',
    'prefixItems',
    'items',
    'contains',
    'additionalProperties',
    'properties',
    'patternProperties',
    'dependentSchemas',
    'propertyNames',
    'if',
    'then',
    'else',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'unevaluatedItems',
    'unevaluatedProperties',
    'type',
    'const',
    'enum',
    'multipleOf',
    'maximum',
    'exclusiveMaximum',
    'minimum',
    'exclusiveMinimum',
    'maxLength',
    'minLength',
    'pattern',
    'maxItems',
    'minItems',
    'uniqueItems',
    'maxContains',
    'minContains',
    'maxProperties',
    'minProperties',
    'required',
    'dependentRequired',
    'format',
    'contentEncoding',
    'contentMediaType',
    'contentSchema',
    'title',
    'description',
    'default',
    'deprecated',
    'readOnly',
    'writeOnly',
    'examples',
  ],
  openApi30: [
    'nullable',
    'discriminator',
    'readOnly',
    'writeOnly',
    'xml',
    'externalDocs',
    'example',
    'deprecated',
  ],
} as const;

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpression(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
      return inner.text;
    }
  }
  return undefined;
}

/** Collect every JSON Schema keyword from an object literal representing a schema node. */
function collectAstSchemaKeywords(
  node: ts.ObjectLiteralExpression,
  found: Map<string, Set<string>>,
  file: string,
): void {
  const recordKey = (key: string): void => {
    const files = found.get(key) ?? new Set<string>();
    files.add(file);
    found.set(key, files);
  };
  for (const prop of node.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      recordKey(prop.name.text);
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyNameText(prop.name);
    if (key === undefined) continue;
    recordKey(key);
    const meta = lookupJsonSchemaKeyword(key);
    const init = unwrapExpression(prop.initializer);
    if (meta?.subschema === 'single') {
      if (ts.isObjectLiteralExpression(init)) collectAstSchemaKeywords(init, found, file);
      else if (ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          const item = unwrapExpression(el);
          if (ts.isObjectLiteralExpression(item)) collectAstSchemaKeywords(item, found, file);
        }
      }
    } else if (meta?.subschema === 'list' && ts.isArrayLiteralExpression(init)) {
      for (const el of init.elements) {
        const item = unwrapExpression(el);
        if (ts.isObjectLiteralExpression(item)) collectAstSchemaKeywords(item, found, file);
      }
    } else if (
      (meta?.subschema === 'map' || meta?.subschema === 'dependencies') &&
      ts.isObjectLiteralExpression(init)
    ) {
      for (const entry of init.properties) {
        if (ts.isPropertyAssignment(entry)) {
          const entryInit = unwrapExpression(entry.initializer);
          if (ts.isObjectLiteralExpression(entryInit)) {
            collectAstSchemaKeywords(entryInit, found, file);
          }
        }
      }
    }
  }
}

function collectFixtureSchemaKeywords(): Map<string, Set<string>> {
  const testsDir = import.meta.dir;
  const fixtureFiles = [
    ...new Set([
      ...readdirSync(testsDir)
        .filter(
          (name) =>
            name.endsWith('.test.ts') &&
            name !== 'json-schema-keyword-table.test.ts' &&
            (name.includes('connections') || name.startsWith('mcp-')),
        )
        .map((name) => join(testsDir, name)),
      join(testsDir, 'connections-fixture.ts'),
      join(testsDir, 'fixtures/cli-json-mcp.ts'),
      join(testsDir, 'fixtures/cli-profile-executable.ts'),
      join(testsDir, 'cli-json-mcp.test.ts'),
      join(testsDir, 'json-schema-remote-verdict.test.ts'),
    ]),
  ];
  const found = new Map<string, Set<string>>();
  for (const file of fixtureFiles) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const name = propertyNameText(node.name);
        const init = unwrapExpression(node.initializer);
        if (
          (name === 'inputSchema' || name === 'schema') &&
          ts.isObjectLiteralExpression(init)
        ) {
          collectAstSchemaKeywords(init, found, file);
          return;
        }
        if (name === 'components' && ts.isObjectLiteralExpression(init)) {
          for (const compProp of init.properties) {
            if (!ts.isPropertyAssignment(compProp)) continue;
            if (propertyNameText(compProp.name) !== 'schemas') continue;
            const schemasObj = unwrapExpression(compProp.initializer);
            if (!ts.isObjectLiteralExpression(schemasObj)) continue;
            for (const schemaProp of schemasObj.properties) {
              if (!ts.isPropertyAssignment(schemaProp)) continue;
              const schemaInit = unwrapExpression(schemaProp.initializer);
              if (ts.isObjectLiteralExpression(schemaInit)) {
                collectAstSchemaKeywords(schemaInit, found, file);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function startMcpWithSchema(
  inputSchema: Record<string, unknown>,
  outputSchema?: Record<string, unknown>,
): string {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method === 'GET') return new Response('', { status: 404 });
      const body = (await request.json()) as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 't', version: '1' },
            }
          : body.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'probe',
                    description: 'Probe',
                    inputSchema,
                    ...(outputSchema !== undefined && { outputSchema }),
                  },
                ],
              }
            : { content: [{ type: 'text', text: 'ok' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  servers.push({ stop: () => void server.stop(true) });
  return `http://127.0.0.1:${server.port}/mcp`;
}

async function mountMcpSchema(
  inputSchema: Record<string, unknown>,
  expose?: readonly ('MCP' | 'AGENT' | 'CLI')[],
  outputSchema?: Record<string, unknown>,
) {
  const url = startMcpWithSchema(inputSchema, outputSchema);
  const skipped: SkippedConnectionTool[] = [];
  const tools = await mountConnections(
    [
      defineMcpClientConnection({
        name: 'mcp',
        transport: { url },
        ...(expose && { expose }),
      }),
    ],
    { onSkippedTool: (entry) => skipped.push(entry) },
  );
  return { tool: tools[0], skipped };
}

async function runDiscoveredCli(
  runtimeTools: readonly RuntimeToolDefinition[],
  argv: string[],
) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    access: { open: 'local-operator' },
    name: 'probe-cli',
    version: '1.0.0',
    runtimeTools: [...runtimeTools],
    argv,
    stdin: async () => null,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
  });
  return { out, err, code };
}

async function mountOpenApi30Schema(bodySchema: Record<string, unknown>, openapi = '3.0.3') {
  const skipped: SkippedConnectionTool[] = [];
  const tools = await mountConnections(
    [
      defineOpenApiConnection({
        name: 'api',
        baseUrl: 'https://example.test',
        spec: {
          openapi,
          ...(bodySchema.$defs !== undefined && { $defs: bodySchema.$defs }),
          ...(bodySchema.definitions !== undefined && { definitions: bodySchema.definitions }),
          paths: {
            '/probe': {
              post: {
                operationId: 'probe',
                requestBody: {
                  required: true,
                  content: { 'application/json': { schema: bodySchema } },
                },
                responses: {},
              },
            },
          },
        },
      }),
    ],
    { onSkippedTool: (entry) => skipped.push(entry) },
  );
  return { tool: tools[0], skipped };
}

interface KeywordSample {
  schema: Record<string, unknown>;
  good: Record<string, unknown>;
  bad?: Record<string, unknown>;
  /** Input that violates a normalized/remote-judged constraint (must not be refused locally). */
  remoteViolation?: Record<string, unknown>;
}

const KEYWORD_SAMPLES: Record<keyof typeof JSON_SCHEMA_KEYWORDS, KeywordSample> = {
  $schema: {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { a: { type: 'string' } },
    },
    good: { a: 'ok' },
  },
  $id: {
    schema: {
      $id: 'https://example.test/s',
      type: 'object',
      properties: { a: { type: 'string' } },
    },
    good: { a: 'ok' },
  },
  $ref: {
    schema: {
      type: 'object',
      $defs: { S: { type: 'string' } },
      properties: { a: { $ref: '#/$defs/S' } },
    },
    good: { a: 'ok' },
    bad: { a: 1 },
  },
  $defs: {
    schema: {
      type: 'object',
      $defs: { S: { type: 'string' } },
      properties: { a: { $ref: '#/$defs/S' } },
    },
    good: { a: 'ok' },
    bad: { a: 1 },
  },
  definitions: {
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      definitions: { S: { type: 'string' } },
      properties: { a: { $ref: '#/definitions/S' } },
    },
    good: { a: 'ok' },
    bad: { a: 1 },
  },
  $comment: {
    schema: { type: 'object', $comment: 'note', properties: { a: { type: 'string' } } },
    good: { a: 'ok' },
  },
  $vocabulary: {
    schema: {
      type: 'object',
      $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true },
      properties: { a: { type: 'string' } },
    },
    good: { a: 'ok' },
  },
  $anchor: {
    schema: {
      type: 'object',
      $defs: { S: { $anchor: 'str', type: 'string' } },
      properties: { a: { type: 'string' } },
    },
    good: { a: 'ok' },
  },
  $dynamicRef: {
    schema: { type: 'object', properties: { a: { $dynamicRef: '#meta' } } },
    good: { a: 'ok' },
  },
  $dynamicAnchor: {
    schema: { type: 'object', $dynamicAnchor: 'root', properties: { a: { type: 'string' } } },
    good: { a: 'ok' },
  },
  allOf: {
    schema: {
      type: 'object',
      properties: {
        a: {
          allOf: [
            { type: 'string', minLength: 2 },
            { type: 'string', maxLength: 4 },
          ],
        },
      },
    },
    good: { a: 'abc' },
    bad: { a: 'toolong' },
  },
  anyOf: {
    schema: {
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    },
    good: { a: 'ok' },
    remoteViolation: { a: true },
  },
  oneOf: {
    schema: {
      type: 'object',
      properties: { a: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    },
    good: { a: 'ok' },
    remoteViolation: { a: true },
  },
  not: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string', not: { const: 'banned' } } },
    },
    good: { a: 'ok' },
    remoteViolation: { a: 'banned' },
  },
  if: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      if: { required: ['a'] },
      then: { required: ['b'] },
    },
    good: { a: 'ok', b: 'yes' },
    remoteViolation: { a: 'ok' },
  },
  then: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      if: { required: ['a'] },
      then: { required: ['b'] },
    },
    good: { a: 'ok', b: 'yes' },
    remoteViolation: { a: 'ok' },
  },
  else: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      if: { required: ['a'] },
      else: { required: ['b'] },
    },
    good: { a: 'ok' },
    remoteViolation: {},
  },
  dependentSchemas: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      dependentSchemas: { a: { required: ['b'] } },
    },
    good: { a: 'ok', b: 'yes' },
    remoteViolation: { a: 'ok' },
  },
  prefixItems: {
    schema: {
      type: 'object',
      properties: {
        a: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
      },
    },
    good: { a: ['x', 1] },
    bad: { a: [1, 'x'] },
  },
  items: {
    schema: {
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'string' } } },
    },
    good: { a: ['x'] },
    bad: { a: [1] },
  },
  additionalItems: {
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        a: { type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'number' } },
      },
    },
    good: { a: ['x', 2] },
    bad: { a: ['x', 'bad'] },
  },
  contains: {
    schema: {
      type: 'object',
      properties: { a: { type: 'array', contains: { type: 'number' } } },
    },
    good: { a: ['x', 1] },
    bad: { a: ['x'] },
  },
  properties: {
    schema: { type: 'object', properties: { a: { type: 'string' } } },
    good: { a: 'ok' },
    bad: { a: 1 },
  },
  patternProperties: {
    schema: {
      type: 'object',
      properties: { a: { type: 'object', patternProperties: { '^x_': { type: 'number' } } } },
    },
    good: { a: { x_1: 1 } },
    bad: { a: { x_1: 'bad' } },
  },
  additionalProperties: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    },
    good: { a: 'ok' },
    bad: { a: 'ok', extra: 1 },
  },
  propertyNames: {
    schema: {
      type: 'object',
      properties: { a: { type: 'object', propertyNames: { minLength: 3 } } },
    },
    good: { a: { abc: 1 } },
    bad: { a: { x: 1 } },
  },
  dependencies: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      dependencies: { a: ['b'] },
    },
    good: { a: 'ok', b: 'yes' },
    remoteViolation: { a: 'ok' },
  },
  unevaluatedItems: {
    schema: {
      type: 'object',
      properties: {
        a: { type: 'array', prefixItems: [{ type: 'string' }], unevaluatedItems: false },
      },
    },
    good: { a: ['x'] },
    remoteViolation: { a: ['x', 'extra'] },
  },
  unevaluatedProperties: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' } },
      unevaluatedProperties: false,
    },
    good: { a: 'ok' },
    remoteViolation: { a: 'ok', extra: 1 },
  },
  type: {
    schema: { type: 'object', properties: { a: { type: 'string' } } },
    good: { a: 'ok' },
    bad: { a: 1 },
  },
  enum: {
    schema: { type: 'object', properties: { a: { enum: ['x', 'y'] } } },
    good: { a: 'x' },
    bad: { a: 'z' },
  },
  const: {
    schema: { type: 'object', properties: { a: { const: 'x' } } },
    good: { a: 'x' },
    bad: { a: 'y' },
  },
  multipleOf: {
    schema: { type: 'object', properties: { a: { type: 'number', multipleOf: 2 } } },
    good: { a: 4 },
    bad: { a: 3 },
  },
  maximum: {
    schema: { type: 'object', properties: { a: { type: 'number', maximum: 5 } } },
    good: { a: 5 },
    bad: { a: 6 },
  },
  exclusiveMaximum: {
    schema: { type: 'object', properties: { a: { type: 'number', exclusiveMaximum: 5 } } },
    good: { a: 4 },
    bad: { a: 5 },
  },
  minimum: {
    schema: { type: 'object', properties: { a: { type: 'number', minimum: 5 } } },
    good: { a: 5 },
    bad: { a: 4 },
  },
  exclusiveMinimum: {
    schema: { type: 'object', properties: { a: { type: 'number', exclusiveMinimum: 5 } } },
    good: { a: 6 },
    bad: { a: 5 },
  },
  maxLength: {
    schema: { type: 'object', properties: { a: { type: 'string', maxLength: 3 } } },
    good: { a: 'ab' },
    bad: { a: 'abcd' },
  },
  minLength: {
    schema: { type: 'object', properties: { a: { type: 'string', minLength: 3 } } },
    good: { a: 'abc' },
    bad: { a: 'ab' },
  },
  pattern: {
    schema: { type: 'object', properties: { a: { type: 'string', pattern: '^[a-z]+$' } } },
    good: { a: 'abc' },
    remoteViolation: { a: '123' },
  },
  maxItems: {
    schema: {
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'string' }, maxItems: 2 } },
    },
    good: { a: ['x'] },
    bad: { a: ['x', 'y', 'z'] },
  },
  minItems: {
    schema: {
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'string' }, minItems: 2 } },
    },
    good: { a: ['x', 'y'] },
    bad: { a: ['x'] },
  },
  uniqueItems: {
    schema: {
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
    },
    good: { a: ['x', 'y'] },
    bad: { a: ['x', 'x'] },
  },
  maxContains: {
    schema: {
      type: 'object',
      properties: { a: { type: 'array', contains: { type: 'number' }, maxContains: 1 } },
    },
    good: { a: [1] },
    bad: { a: [1, 2] },
  },
  minContains: {
    schema: {
      type: 'object',
      properties: { a: { type: 'array', contains: { type: 'number' }, minContains: 2 } },
    },
    good: { a: [1, 2] },
    bad: { a: [1] },
  },
  maxProperties: {
    schema: { type: 'object', properties: { a: { type: 'object', maxProperties: 1 } } },
    good: { a: { x: 1 } },
    bad: { a: { x: 1, y: 2 } },
  },
  minProperties: {
    schema: { type: 'object', properties: { a: { type: 'object', minProperties: 2 } } },
    good: { a: { x: 1, y: 2 } },
    bad: { a: { x: 1 } },
  },
  required: {
    schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    good: { a: 'ok' },
    bad: {},
  },
  dependentRequired: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      dependentRequired: { a: ['b'] },
    },
    good: { a: 'ok', b: 'yes' },
    remoteViolation: { a: 'ok' },
  },
  format: {
    schema: { type: 'object', properties: { a: { type: 'string', format: 'email' } } },
    good: { a: 'a@example.test' },
    remoteViolation: { a: 'not-an-email' },
  },
  contentEncoding: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string', contentEncoding: 'base64' } },
    },
    good: { a: 'YWJj' },
    remoteViolation: { a: '!!!not-base64!!!' },
  },
  contentMediaType: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string', contentMediaType: 'application/json' } },
    },
    good: { a: '{}' },
    remoteViolation: { a: 'not-json' },
  },
  contentSchema: {
    schema: {
      type: 'object',
      properties: { a: { type: 'string', contentSchema: { type: 'object' } } },
    },
    good: { a: '{}' },
    remoteViolation: { a: 'not-object' },
  },
  title: {
    schema: { type: 'object', title: 'Probe', properties: { a: { type: 'string' } } },
    good: { a: 'ok' },
  },
  description: {
    schema: { type: 'object', description: 'Probe', properties: { a: { type: 'string' } } },
    good: { a: 'ok' },
  },
  default: {
    schema: { type: 'object', properties: { a: { type: 'string', default: 'x' } } },
    good: { a: 'ok' },
  },
  deprecated: {
    schema: { type: 'object', properties: { a: { type: 'string', deprecated: true } } },
    good: { a: 'ok' },
  },
  readOnly: {
    schema: { type: 'object', properties: { a: { type: 'string', readOnly: true } } },
    good: { a: 'ok' },
  },
  writeOnly: {
    schema: { type: 'object', properties: { a: { type: 'string', writeOnly: true } } },
    good: { a: 'ok' },
  },
  examples: {
    schema: { type: 'object', properties: { a: { type: 'string', examples: ['ok'] } } },
    good: { a: 'ok' },
  },
  nullable: {
    schema: { type: 'object', properties: { a: { type: 'string', nullable: true } } },
    good: { a: null },
    bad: { a: 123 },
  },
  discriminator: {
    schema: {
      type: 'object',
      properties: {
        a: {
          oneOf: [
            { type: 'object', properties: { k: { const: 'x' } }, required: ['k'] },
            { type: 'object', properties: { k: { const: 'y' } }, required: ['k'] },
          ],
          discriminator: { propertyName: 'k' },
        },
      },
    },
    good: { a: { k: 'x' } },
    remoteViolation: { a: { k: 'other' } },
  },
  xml: {
    schema: { type: 'object', properties: { a: { type: 'string', xml: { name: 'a' } } } },
    good: { a: 'ok' },
  },
  externalDocs: {
    schema: {
      type: 'object',
      externalDocs: { url: 'https://example.test' },
      properties: { a: { type: 'string' } },
    },
    good: { a: 'ok' },
  },
  example: {
    schema: { type: 'object', properties: { a: { type: 'string', example: 'ok' } } },
    good: { a: 'ok' },
  },
};

describe('JSON Schema keyword table completeness', () => {
  test('every draft-07, 2020-12 and OpenAPI 3.0 vocabulary word has a row in JSON_SCHEMA_KEYWORDS', () => {
    const missing: string[] = [];
    for (const words of Object.values(VOCABULARY_INVENTORY)) {
      for (const word of words) {
        if (!Object.hasOwn(JSON_SCHEMA_KEYWORDS, word)) missing.push(word);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every schema keyword across connection fixtures in packages/core/tests/ is covered by the table', () => {
    const fixtureKeywords = collectFixtureSchemaKeywords();
    expect(fixtureKeywords.size).toBeGreaterThan(0);
    const missing: Array<{ keyword: string; files: string[] }> = [];
    for (const [keyword, files] of fixtureKeywords) {
      if (lookupJsonSchemaKeyword(keyword) === undefined) {
        missing.push({ keyword, files: [...files].sort() });
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('JSON Schema keyword outcomes on MCP and OpenAPI paths', () => {
  test('every table row satisfies its declared outcome on both MCP and OpenAPI 3.0', async () => {
    const rows = Object.entries(JSON_SCHEMA_KEYWORDS) as Array<
      [keyof typeof JSON_SCHEMA_KEYWORDS, KeywordRow]
    >;
    for (const [keyword, meta] of rows) {
      const sample = KEYWORD_SAMPLES[keyword];
      // MCP path
      const mcp = await mountMcpSchema(sample.schema);
      if (meta.readMcp === 'refused') {
        expect(mcp.tool).toBeUndefined();
        expect(mcp.skipped).toHaveLength(1);
        expect(mcp.skipped[0]?.reason).toContain(keyword);
      } else {
        expect(mcp.skipped).toEqual([]);
        if (!mcp.tool) throw new Error(`Expected MCP tool mounted for ${keyword}`);
        const input = mcp.tool.input;
        expect(input.safeParse(sample.good).success).toBe(true);
        if (meta.readMcp === 'preserved') {
          expect(sample.bad).toBeDefined();
          const failed = input.safeParse(sample.bad);
          expect(failed.success).toBe(false);
          if (!failed.success) expect(localVerdict(input, failed.error)).not.toBeNull();
        } else if (meta.readMcp === 'normalized') {
          if (sample.remoteViolation !== undefined) {
            const check = input.safeParse(sample.remoteViolation);
            expect(check.success === true || localVerdict(input, check.error) === null).toBe(
              true,
            );
          }
          if (keyword === 'nullable' && sample.bad !== undefined) {
            const failed = input.safeParse(sample.bad);
            expect(failed.success).toBe(false);
            if (!failed.success) expect(localVerdict(input, failed.error)).toBeNull();
          }
        }
      }

      // OpenAPI 3.0 path
      const openapi = await mountOpenApi30Schema(sample.schema, '3.0.3');
      if (meta.readOpenApi === 'refused') {
        expect(openapi.tool).toBeUndefined();
        expect(openapi.skipped).toHaveLength(1);
        expect(openapi.skipped[0]?.reason).toContain(keyword);
      } else {
        expect(openapi.skipped).toEqual([]);
        if (!openapi.tool) throw new Error(`Expected OpenAPI tool mounted for ${keyword}`);
        const input = openapi.tool.input;
        expect(input.safeParse({ body: sample.good }).success).toBe(true);
        if (meta.readOpenApi === 'preserved') {
          expect(sample.bad).toBeDefined();
          const failed = input.safeParse({ body: sample.bad });
          expect(failed.success).toBe(false);
          if (!failed.success) expect(localVerdict(input, failed.error)).not.toBeNull();
        } else if (meta.readOpenApi === 'normalized' && sample.remoteViolation !== undefined) {
          const check = input.safeParse({ body: sample.remoteViolation });
          expect(check.success === true || localVerdict(input, check.error) === null).toBe(
            true,
          );
        }
      }
    }
  }, 30_000);

  test('unknown keyword outside the table is reported in onSkipped with its name; x-* passes as annotation', async () => {
    const unknownMcp = await mountMcpSchema({
      type: 'object',
      properties: { a: { type: 'string', unknownCustomKeyword: true } },
    });
    expect(unknownMcp.tool).toBeUndefined();
    expect(unknownMcp.skipped).toHaveLength(1);
    expect(unknownMcp.skipped[0]?.reason).toContain('unknownCustomKeyword');

    const extMcp = await mountMcpSchema({
      type: 'object',
      'x-vendor-flag': true,
      properties: { a: { type: 'string', 'x-ui-hint': 'short' } },
    });
    expect(extMcp.skipped).toEqual([]);
    expect(extMcp.tool?.input.safeParse({ a: 'ok' }).success).toBe(true);
  });
});

describe('foreign schema ingestion fixes (OpenAPI 3.0 nullable, top-level union, remote constraints)', () => {
  test('OpenAPI 3.0 nullable accepts null and valid value while refusing wrong type', async () => {
    const mounted = await mountOpenApi30Schema(
      { type: 'object', properties: { a: { type: 'string', nullable: true } } },
      '3.0.3',
    );
    expect(mounted.skipped).toEqual([]);
    expect(mounted.tool?.input.safeParse({ body: { a: null } }).success).toBe(true);
    expect(mounted.tool?.input.safeParse({ body: { a: 'hello' } }).success).toBe(true);
    expect(mounted.tool?.input.safeParse({ body: { a: 42 } }).success).toBe(false);
  });

  test('MCP nullable: true is normalized to accept null and refuse incompatible types', async () => {
    const mounted = await mountMcpSchema({
      type: 'object',
      properties: { a: { type: 'string', nullable: true } },
    });
    expect(mounted.skipped).toEqual([]);
    expect(mounted.tool?.input.safeParse({ a: null }).success).toBe(true);
    expect(mounted.tool?.input.safeParse({ a: 'hello' }).success).toBe(true);
    expect(mounted.tool?.input.safeParse({ a: 123 }).success).toBe(false);
  });

  test('2020-12 dialect normalizes nullable: true to accept null and refuse wrong types', () => {
    const schema = zodObjectFromJsonSchema(
      { type: 'object', properties: { a: { type: 'string', nullable: true } } },
      { dialect: '2020-12' },
    );
    expect(schema.safeParse({ a: null }).success).toBe(true);
    expect(schema.safeParse({ a: 'hello' }).success).toBe(true);
    expect(schema.safeParse({ a: 123 }).success).toBe(false);
  });

  test('draft-07 top-level oneOf/anyOf with #/definitions/ refs preserves $schema and resolves refs', async () => {
    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const mounted = await mountMcpSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        definitions: {
          Tag: { type: 'string', minLength: 2 },
        },
        [keyword]: [
          {
            type: 'object',
            properties: { tag: { $ref: '#/definitions/Tag' } },
            required: ['tag'],
          },
          {
            type: 'object',
            properties: { count: { type: 'number' } },
            required: ['count'],
          },
        ],
      });
      expect(mounted.skipped).toEqual([]);
      if (!mounted.tool) throw new Error(`Expected draft-07 ${keyword} tool mounted`);
      expect(mounted.tool.input.safeParse({ tag: 'ok' }).success).toBe(true);
      expect(mounted.tool.input.safeParse({ count: 3 }).success).toBe(true);
      expect(mounted.tool.input.safeParse({ tag: 'x' }).success).toBe(false);
    }
  });

  test('a root that declares both oneOf and anyOf is skipped instead of losing one of them', async () => {
    const mounted = await mountMcpSchema({
      type: 'object',
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
      anyOf: [{ type: 'object', properties: { c: { type: 'string' } }, required: ['c'] }],
    });
    expect(mounted.tool).toBeUndefined();
    expect(JSON.stringify(mounted.skipped)).toContain('oneOf and anyOf together');
  });

  test('root schema with both properties and oneOf/anyOf merges root and branch fields instead of returning empty looseObject', () => {
    const withBranchProps = zodObjectFromJsonSchema({
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      oneOf: [
        {
          type: 'object',
          properties: { email: { type: 'string' } },
          required: ['email'],
        },
        {
          type: 'object',
          properties: { phone: { type: 'number' } },
          required: ['phone'],
        },
      ],
    });
    expect(withBranchProps.safeParse({ id: 'u1', email: 'a@b.test' }).success).toBe(true);
    expect(withBranchProps.safeParse({ id: 'u1', phone: 123 }).success).toBe(true);
    expect(withBranchProps.safeParse({ email: 'a@b.test' }).success).toBe(false);
    expect(withBranchProps.safeParse({ id: 'u1', phone: 'not-a-number' }).success).toBe(false);

    const withRequiredOnlyBranches = zodObjectFromJsonSchema({
      type: 'object',
      properties: {
        id: { type: 'string' },
        a: { type: 'string' },
        b: { type: 'number' },
      },
      required: ['id'],
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
    });
    expect(withRequiredOnlyBranches.safeParse({ id: 'u1', a: 'x' }).success).toBe(true);
    expect(withRequiredOnlyBranches.safeParse({ id: 'u1', b: 2 }).success).toBe(true);
    expect(withRequiredOnlyBranches.safeParse({ a: 'x' }).success).toBe(false);
    expect(withRequiredOnlyBranches.safeParse({ id: 'u1', b: 'bad' }).success).toBe(false);
  });

  test('nested draft-07 tuple items lists are recursively rewritten to prefixItems and keep served formats', () => {
    const nested = {
      type: 'object',
      properties: {
        matrix: {
          type: 'array',
          items: [
            {
              type: 'array',
              items: [{ type: 'string', format: 'uuid' }],
            },
          ],
        },
      },
    };
    const rewritten = withDraft2020Keywords(nested);
    expect(rewritten).toEqual({
      type: 'object',
      properties: {
        matrix: {
          type: 'array',
          prefixItems: [
            {
              type: 'array',
              prefixItems: [{ type: 'string', format: 'uuid' }],
            },
          ],
        },
      },
    });
    const formatted = withServedFormats(nested);
    expect(formatted).toEqual({
      type: 'object',
      properties: {
        matrix: {
          type: 'array',
          items: [
            {
              type: 'array',
              items: [{ type: 'string', format: 'uuid', 'x-stitchkit-served-format': 'uuid' }],
            },
          ],
        },
      },
    });
  });

  test('top-level oneOf/anyOf of object branches merges fields instead of yielding an empty object', async () => {
    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const mounted = await mountMcpSchema({
        [keyword]: [
          {
            type: 'object',
            properties: { kind: { const: 'a' }, label: { type: 'string' } },
            required: ['kind', 'label'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { kind: { const: 'b' }, count: { type: 'number' } },
            required: ['kind', 'count'],
            additionalProperties: false,
          },
        ],
      });
      expect(mounted.skipped).toEqual([]);
      if (!mounted.tool) throw new Error(`Expected top-level ${keyword} tool mounted`);
      const input = mounted.tool.input;
      expect(input.safeParse({ kind: 'a', label: 'hi' }).success).toBe(true);
      expect(input.safeParse({ kind: 'b', count: 3 }).success).toBe(true);
      expect(input.safeParse({}).success).toBe(false);
      expect(input.safeParse({ kind: 'c' }).success).toBe(false);
      expect(input.safeParse({ kind: 'a', label: 'hi', unexpected: true }).success).toBe(
        false,
      );
    }
  });

  test('top-level oneOf/anyOf with a non-object branch is refused in onSkipped', async () => {
    const mounted = await mountMcpSchema({
      oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'string' }],
    });
    expect(mounted.tool).toBeUndefined();
    expect(mounted.skipped).toHaveLength(1);
    expect(mounted.skipped[0]?.reason).toContain('non-object');
  });

  test('not, dependentRequired, dependentSchemas, if/then/else, unevaluated* and dependencies do not drop the tool', async () => {
    const mounted = await mountMcpSchema({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        list: { type: 'array', items: { type: 'string' }, unevaluatedItems: false },
      },
      not: { required: ['a', 'b'] },
      dependentRequired: { a: ['b'] },
      dependentSchemas: { b: { required: ['a'] } },
      if: { required: ['a'] },
      then: { required: ['b'] },
      else: { properties: { b: { type: 'string' } } },
      unevaluatedProperties: false,
      dependencies: { a: ['b'] },
    });
    expect(mounted.skipped).toEqual([]);
    expect(mounted.tool).toBeDefined();
    expect(mounted.tool?.input.safeParse({ a: 'x', list: ['y'] }).success).toBe(true);
  });
});

describe('root-level JSON Schema object keywords preserve shape, validation, CLI help/schema and MCP mount', () => {
  interface RootKeywordCase {
    name: string;
    schema: Record<string, unknown>;
    shapeKeys: string[];
    requiredKeys: string[];
    good: Record<string, unknown>;
    bad: Record<string, unknown>;
    extraBad?: Record<string, unknown>;
  }

  const ROOT_CASES: readonly RootKeywordCase[] = [
    {
      name: 'allOf',
      schema: {
        allOf: [
          { properties: { a: { type: 'string' } }, required: ['a'] },
          { properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      },
      shapeKeys: ['a', 'b'],
      requiredKeys: ['a', 'b'],
      good: { a: 'ok', b: 2 },
      bad: { a: 'ok' },
    },
    {
      name: 'minProperties',
      schema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        minProperties: 1,
      },
      shapeKeys: ['a', 'b'],
      requiredKeys: [],
      good: { a: 'ok' },
      bad: {},
    },
    {
      name: 'maxProperties',
      schema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        maxProperties: 1,
      },
      shapeKeys: ['a', 'b'],
      requiredKeys: [],
      good: { a: 'ok' },
      bad: { a: 'ok', b: 2 },
    },
    {
      name: 'propertyNames',
      schema: {
        type: 'object',
        properties: { abc: { type: 'string' } },
        required: ['abc'],
        propertyNames: { minLength: 3 },
      },
      shapeKeys: ['abc'],
      requiredKeys: ['abc'],
      good: { abc: 'ok' },
      bad: { abc: 'ok', x: 'short' },
    },
    {
      name: 'patternProperties',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        patternProperties: { '^x_': { type: 'number' } },
      },
      shapeKeys: ['id'],
      requiredKeys: ['id'],
      good: { id: 'u1', x_count: 3 },
      bad: { id: 'u1', x_count: 'not-a-number' },
    },
    {
      name: 'allOf + type:object',
      schema: {
        type: 'object',
        allOf: [
          { properties: { a: { type: 'string' } }, required: ['a'] },
          { properties: { b: { type: 'number' } } },
        ],
      },
      shapeKeys: ['a', 'b'],
      requiredKeys: ['a'],
      good: { a: 'ok', b: 5 },
      bad: { b: 5 },
    },
    {
      name: 'additionalProperties: false + minProperties: 1',
      schema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        additionalProperties: false,
        minProperties: 1,
      },
      shapeKeys: ['a', 'b'],
      requiredKeys: [],
      good: { a: 'ok' },
      bad: {},
      extraBad: { a: 'ok', extra: true },
    },
    {
      name: 'oneOf + minProperties: 2',
      schema: {
        type: 'object',
        minProperties: 2,
        oneOf: [
          {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'number' } },
            required: ['a'],
          },
          {
            type: 'object',
            properties: { a: { type: 'string' }, c: { type: 'boolean' } },
            required: ['a'],
          },
        ],
      },
      shapeKeys: ['a', 'b', 'c'],
      requiredKeys: ['a'],
      good: { a: 'ok', b: 1 },
      bad: { a: 'ok' },
      extraBad: { b: 1, c: true },
    },
  ];

  test.each(ROOT_CASES)(
    '$name preserves shape, required, validation, CLI --help/--schema and MCP mount',
    async ({ schema, shapeKeys, requiredKeys, good, bad, extraBad }) => {
      const mounted = await mountMcpSchema(schema, ['CLI', 'MCP']);
      expect(mounted.skipped).toEqual([]);
      if (!mounted.tool) throw new Error('Expected MCP tool to mount');
      const tool = mounted.tool;

      // (a) .shape & required preserved
      expect(Object.keys(tool.input.shape).sort()).toEqual([...shapeKeys].sort());
      const presentation = buildToolPresentationSchema({
        inputSchema: tool.input,
        unrepresentable: 'throw',
      });
      expect(isObjectPresentationSchema(presentation)).toBe(true);
      const presentedProps = isRecord(presentation.properties)
        ? Object.keys(presentation.properties).sort()
        : [];
      expect(presentedProps).toEqual([...shapeKeys].sort());
      const presentedRequired = Array.isArray(presentation.required)
        ? [...presentation.required].sort()
        : [];
      expect(presentedRequired).toEqual([...requiredKeys].sort());

      // (b) valid input passes AND root-keyword-violating input FAILS safeParse
      expect(tool.input.safeParse(good).success).toBe(true);
      expect(tool.input.safeParse(bad).success).toBe(false);
      if (extraBad) expect(tool.input.safeParse(extraBad).success).toBe(false);

      // (c) discovered CLI --help and --schema show properties/required
      const help = await runDiscoveredCli([tool], ['probe', '--help']);
      expect(help.code).toBe(0);
      for (const key of shapeKeys) {
        expect(help.out).toContain(`--${key}`);
      }
      if (requiredKeys.length > 0) expect(help.out).toContain('(required)');

      const schemaOut = await runDiscoveredCli([tool], ['probe', '--schema']);
      expect(schemaOut.code).toBe(0);
      const schemaDoc: unknown = JSON.parse(schemaOut.out);
      if (!isRecord(schemaDoc) || !isRecord(schemaDoc.input)) {
        throw new Error('Expected JSON schema document from --schema');
      }
      const cliProps = isRecord(schemaDoc.input.properties)
        ? Object.keys(schemaDoc.input.properties).sort()
        : [];
      expect(cliProps).toEqual([...shapeKeys].sort());
      const cliRequired = Array.isArray(schemaDoc.input.required)
        ? [...schemaDoc.input.required].sort()
        : [];
      expect(cliRequired).toEqual([...requiredKeys].sort());

      // (d) MCP surface accepts it and lists object schema with properties & required
      const mcpServer = buildMcpServer({
        serverInfo: { name: 'reexport', version: '1.0.0' },
        access: { open: 'local-operator' },
        services: [],
        runtimeTools: [tool],
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const listed = await client.listTools();
        const listedTool = listed.tools.find((entry) => entry.name === 'probe');
        expect(listedTool).toBeDefined();
        const listedInput = listedTool?.inputSchema;
        if (!isRecord(listedInput)) throw new Error('Expected listed inputSchema');
        expect(listedInput.type).toBe('object');
        const listedProps = isRecord(listedInput.properties)
          ? Object.keys(listedInput.properties).sort()
          : [];
        expect(listedProps).toEqual([...shapeKeys].sort());
        const listedRequired = Array.isArray(listedInput.required)
          ? [...listedInput.required].sort()
          : [];
        expect(listedRequired).toEqual([...requiredKeys].sort());
      } finally {
        await client.close();
      }
    },
  );

  test('allOf resolves $ref, flattens nested allOf, merges duplicate properties without overwriting, and unions required', () => {
    const schema = zodObjectFromJsonSchema({
      $defs: {
        Base: {
          properties: {
            name: { type: 'string', minLength: 3 },
            id: { type: 'string' },
          },
          required: ['id'],
        },
        Extended: {
          allOf: [
            { $ref: '#/$defs/Base' },
            {
              properties: {
                name: { maxLength: 5 },
                tag: { type: 'string' },
              },
              required: ['name'],
            },
          ],
        },
      },
      allOf: [
        { $ref: '#/$defs/Extended' },
        { properties: { count: { type: 'number' } }, required: ['count'] },
      ],
    });
    expect(Object.keys(schema.shape).sort()).toEqual(['count', 'id', 'name', 'tag']);
    expect(schema.safeParse({ id: '1', name: 'abc', count: 2 }).success).toBe(true);
    // Both minLength: 3 (from Base) and maxLength: 5 (from Extended) must apply!
    expect(schema.safeParse({ id: '1', name: 'ab', count: 2 }).success).toBe(false);
    expect(schema.safeParse({ id: '1', name: 'abcdef', count: 2 }).success).toBe(false);
    // Union of required: id, name, count
    expect(schema.safeParse({ name: 'abc', count: 2 }).success).toBe(false);
    expect(schema.safeParse({ id: '1', count: 2 }).success).toBe(false);
    expect(schema.safeParse({ id: '1', name: 'abc' }).success).toBe(false);
  });

  test('irreconcilable or non-object allOf throws instead of silently returning an empty looseObject', async () => {
    expect(() =>
      zodObjectFromJsonSchema({
        allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'string' }],
      }),
    ).toThrow(/non-object/i);

    const mounted = await mountMcpSchema({
      allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'number' }],
    });
    expect(mounted.tool).toBeUndefined();
    expect(mounted.skipped).toHaveLength(1);
    expect(mounted.skipped[0]?.reason).toMatch(/non-object/i);
  });

  test('patternProperties with additionalProperties: false allows pattern-matched keys and rejects extras', () => {
    const schema = zodObjectFromJsonSchema({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      patternProperties: { '^x_': { type: 'number' }, '^y_': { type: 'boolean' } },
      additionalProperties: false,
    });
    expect(Object.keys(schema.shape)).toEqual(['id']);
    expect(schema.safeParse({ id: '1', x_a: 42, y_ok: true }).success).toBe(true);
    expect(schema.safeParse({ id: '1', x_a: 'bad' }).success).toBe(false);
    expect(schema.safeParse({ id: '1', y_ok: 123 }).success).toBe(false);
    expect(schema.safeParse({ id: '1', unexpected: 1 }).success).toBe(false);
  });

  test('patternProperties without properties recovers a validating ZodObject that mounts on MCP', () => {
    const schema = zodObjectFromJsonSchema({
      type: 'object',
      patternProperties: { '^x_': { type: 'number' } },
      additionalProperties: false,
    });
    expect(schema.safeParse({ x_1: 10 }).success).toBe(true);
    expect(schema.safeParse({ x_1: 'bad' }).success).toBe(false);
    expect(schema.safeParse({ other: 1 }).success).toBe(false);
    const presentation = buildToolPresentationSchema({
      inputSchema: schema,
      unrepresentable: 'throw',
    });
    expect(isObjectPresentationSchema(presentation)).toBe(true);
  });

  test('root propertyNames format forwards original invalid_key/invalid_format issues without duplicating formats', () => {
    const schema = zodObjectFromJsonSchema({
      type: 'object',
      properties: { 'owner@example.test': { type: 'string', format: 'email' } },
      propertyNames: { format: 'email' },
    });
    const failed = schema.safeParse({ badkey: 'also-not-email' });
    expect(failed.success).toBe(false);
    if (failed.success) throw new Error('Expected invalid key failure');
    expect(failed.error.issues.map((issue) => issue.code)).toEqual(['invalid_key']);
    expect(localVerdict(schema, failed.error)).toBeNull();

    const both = schema.safeParse({ 'owner@example.test': 'not-an-email', badkey: 'x' });
    expect(both.success).toBe(false);
    if (both.success) throw new Error('Expected failure');
    const propFormatIssues = both.error.issues.filter(
      (issue) => issue.code === 'invalid_format',
    );
    expect(propFormatIssues).toHaveLength(1);
    expect(localVerdict(schema, both.error)).toBeNull();
  });

  test('top-level oneOf/anyOf preserves sibling root keywords (maxProperties, propertyNames, patternProperties, schema additionalProperties)', () => {
    const schema = zodObjectFromJsonSchema({
      type: 'object',
      maxProperties: 2,
      propertyNames: { minLength: 2 },
      patternProperties: { '^x_': { type: 'number' } },
      oneOf: [
        { type: 'object', properties: { alpha: { type: 'string' } }, required: ['alpha'] },
        { type: 'object', properties: { beta: { type: 'string' } }, required: ['beta'] },
      ],
    });
    expect(Object.keys(schema.shape).sort()).toEqual(['alpha', 'beta']);
    expect(schema.safeParse({ alpha: 'ok', x_n: 1 }).success).toBe(true);
    expect(schema.safeParse({ alpha: 'ok', beta: 'ok', x_n: 1 }).success).toBe(false);
    expect(schema.safeParse({ alpha: 'ok', a: 1 }).success).toBe(false);
    expect(schema.safeParse({ alpha: 'ok', x_n: 'bad' }).success).toBe(false);

    const withCatchall = zodObjectFromJsonSchema({
      type: 'object',
      additionalProperties: { type: 'number' },
      anyOf: [
        { type: 'object', properties: { alpha: { type: 'string' } } },
        { type: 'object', properties: { beta: { type: 'string' } } },
      ],
    });
    expect(withCatchall.safeParse({ alpha: 'ok', extra: 5 }).success).toBe(true);
    expect(withCatchall.safeParse({ alpha: 'ok', extra: 'not-number' }).success).toBe(false);
  });

  test('mutual allOf <-> oneOf/anyOf cyclic $ref, direct cyclic $ref, unresolvable $ref and empty allOf throw clear Errors', () => {
    const mutualCases: Record<string, unknown>[] = [
      {
        $defs: {
          A: { allOf: [{ $ref: '#/$defs/B' }] },
          B: { oneOf: [{ $ref: '#/$defs/A' }] },
        },
        allOf: [{ $ref: '#/$defs/A' }],
      },
      {
        $defs: {
          A: { oneOf: [{ $ref: '#/$defs/B' }] },
          B: { allOf: [{ $ref: '#/$defs/A' }] },
        },
        oneOf: [{ $ref: '#/$defs/A' }],
      },
      {
        $defs: {
          A: { allOf: [{ $ref: '#/$defs/B' }] },
          B: { anyOf: [{ $ref: '#/$defs/A' }] },
        },
        allOf: [{ $ref: '#/$defs/A' }],
      },
      {
        $defs: { A: { $ref: '#/$defs/A' } },
        allOf: [{ $ref: '#/$defs/A' }],
      },
      {
        $defs: { A: { $ref: '#/$defs/A' } },
        oneOf: [{ $ref: '#/$defs/A' }],
      },
      {
        $defs: { A: { $ref: '#/$defs/A' } },
        $ref: '#/$defs/A',
      },
    ];
    for (const cyclic of mutualCases) {
      let caught: unknown;
      try {
        zodObjectFromJsonSchema(cyclic);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(RangeError);
      expect(caught instanceof Error ? caught.message : '').toMatch(/circular \$ref/i);
    }

    for (const missing of [
      { allOf: [{ $ref: '#/$defs/Missing' }] },
      { oneOf: [{ $ref: '#/$defs/Missing' }] },
      { $ref: '#/$defs/Missing' },
    ]) {
      expect(() => zodObjectFromJsonSchema(missing)).toThrow(/unresolvable \$ref/i);
    }

    expect(() => zodObjectFromJsonSchema({ allOf: [] })).toThrow(
      /at least one object branch/i,
    );
  });

  test('root $ref pointing to allOf/oneOf or carrying Draft 2020-12 siblings preserves full shape while plain recursive root $ref stays intact', () => {
    // Typeless allOf branches behind root $ref
    const typelessRef = zodObjectFromJsonSchema({
      $defs: {
        Merged: {
          allOf: [
            { properties: { a: { type: 'string' } }, required: ['a'] },
            { properties: { b: { type: 'number' } }, required: ['b'] },
          ],
        },
      },
      $ref: '#/$defs/Merged',
    });
    expect(Object.keys(typelessRef.shape).sort()).toEqual(['a', 'b']);
    expect(typelessRef.safeParse({ a: 'ok', b: 2 }).success).toBe(true);
    expect(typelessRef.safeParse({ a: 'ok' }).success).toBe(false);
    expect(typelessRef.safeParse({ b: 2 }).success).toBe(false);

    // Explicitly typed allOf branches behind root $ref must keep BOTH a and b in .shape
    const typedRef = zodObjectFromJsonSchema({
      $defs: {
        Merged: {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
          ],
        },
      },
      $ref: '#/$defs/Merged',
    });
    expect(Object.keys(typedRef.shape).sort()).toEqual(['a', 'b']);
    expect(typedRef.safeParse({ a: 'ok', b: 2 }).success).toBe(true);
    expect(typedRef.safeParse({ a: 'ok' }).success).toBe(false);
    expect(typedRef.safeParse({ b: 2 }).success).toBe(false);

    // Root $ref pointing to oneOf
    const unionRef = zodObjectFromJsonSchema({
      $defs: {
        Choice: {
          oneOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
          ],
        },
      },
      $ref: '#/$defs/Choice',
    });
    expect(Object.keys(unionRef.shape).sort()).toEqual(['a', 'b']);
    expect(unionRef.safeParse({ a: 'ok' }).success).toBe(true);
    expect(unionRef.safeParse({ b: 7 }).success).toBe(true);
    expect(unionRef.safeParse({ a: 123 }).success).toBe(false);

    // Root $ref with Draft 2020-12 siblings (required + properties)
    const siblingRef = zodObjectFromJsonSchema({
      $defs: {
        Base: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'number' } },
        },
      },
      $ref: '#/$defs/Base',
      required: ['a'],
      properties: { c: { type: 'boolean' } },
    });
    expect(Object.keys(siblingRef.shape).sort()).toEqual(['a', 'b', 'c']);
    expect(siblingRef.safeParse({ a: 'ok', c: true }).success).toBe(true);
    expect(siblingRef.safeParse({ b: 1 }).success).toBe(false);

    // Plain recursive root $ref keeps native recursion on both input and output paths
    const recursiveDoc = {
      $defs: {
        Node: {
          type: 'object',
          properties: { name: { type: 'string' }, child: { $ref: '#/$defs/Node' } },
          required: ['name'],
        },
      },
      $ref: '#/$defs/Node',
    };
    const recInput = zodObjectFromJsonSchema(recursiveDoc);
    const recOutput = zodOutputFromJsonSchema(recursiveDoc);
    for (const schema of [recInput, recOutput]) {
      expect(schema.safeParse({ name: 'root', child: { name: 'leaf' } }).success).toBe(true);
      expect(schema.safeParse({ child: { name: 'leaf' } }).success).toBe(false);
    }
  });

  test('Draft 2020-12 sibling keywords next to $ref inside oneOf/anyOf branches are preserved', () => {
    const oneOfSiblings = zodObjectFromJsonSchema({
      $defs: {
        Base: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'number' } },
        },
      },
      oneOf: [
        { $ref: '#/$defs/Base', required: ['a'] },
        { $ref: '#/$defs/Base', required: ['a', 'b'] },
      ],
    });
    expect(oneOfSiblings.safeParse({ a: 'ok' }).success).toBe(true);
    expect(oneOfSiblings.safeParse({}).success).toBe(false);

    const anyOfSiblings = zodObjectFromJsonSchema({
      $defs: {
        Base: {
          type: 'object',
          properties: { a: { type: 'string' } },
        },
      },
      anyOf: [
        { $ref: '#/$defs/Base', properties: { b: { type: 'number' } }, required: ['a'] },
        { $ref: '#/$defs/Base', properties: { c: { type: 'boolean' } }, required: ['a'] },
      ],
    });
    expect(Object.keys(anyOfSiblings.shape).sort()).toEqual(['a', 'b', 'c']);
    expect(anyOfSiblings.safeParse({ a: 'ok', b: 1 }).success).toBe(true);
    expect(anyOfSiblings.safeParse({ b: 1 }).success).toBe(false);
    expect(anyOfSiblings.safeParse({ a: 'ok', c: 'not-bool' }).success).toBe(false);
  });

  test('allOf merges minProperties, maxProperties, propertyNames, patternProperties and additionalProperties across branches', () => {
    const merged = zodObjectFromJsonSchema({
      allOf: [
        {
          properties: { aa: { type: 'string' } },
          minProperties: 2,
          maxProperties: 5,
          propertyNames: { minLength: 2 },
          patternProperties: { '^x_': { type: 'number' } },
        },
        {
          properties: { bb: { type: 'string' } },
          minProperties: 3,
          maxProperties: 4,
          propertyNames: { maxLength: 4 },
          patternProperties: { '^x_': { minimum: 10 }, '^y_': { type: 'boolean' } },
        },
      ],
    });
    // 3 keys valid, 2 keys violates max(2,3)=3, 5 keys violates min(5,4)=4
    expect(merged.safeParse({ bb: 'ok', x_1: 10, y_1: true }).success).toBe(true);
    expect(merged.safeParse({ bb: 'ok', x_1: 10 }).success).toBe(false);
    expect(merged.safeParse({ bb: 'ok', x_1: 10, y_1: true, z1: 6, z2: 7 }).success).toBe(
      false,
    );
    // propertyNames: minLength 2 AND maxLength 4
    expect(merged.safeParse({ bb: 'ok', x_1: 10, a: 6 }).success).toBe(false);
    expect(merged.safeParse({ bb: 'ok', x_1: 10, longk: 6 }).success).toBe(false);
    // patternProperties: ^x_ requires number >= 10, ^y_ requires boolean
    expect(merged.safeParse({ bb: 'ok', x_1: 5, y_1: true }).success).toBe(false);
    expect(merged.safeParse({ bb: 'ok', x_1: 10, y_1: 'bad' }).success).toBe(false);

    // Schema-valued additionalProperties merges across allOf branches (propagating type)
    const catchallMerged = zodObjectFromJsonSchema({
      allOf: [
        { properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } },
        { properties: { b: { type: 'string' } }, additionalProperties: { minimum: 5 } },
      ],
    });
    expect(catchallMerged.safeParse({ a: 'ok', extra: 6 }).success).toBe(true);
    expect(catchallMerged.safeParse({ a: 'ok', extra: 4 }).success).toBe(false);
    expect(catchallMerged.safeParse({ a: 'ok', extra: 'bad' }).success).toBe(false);

    // additionalProperties: false wins over schema-valued additionalProperties
    const strictMerged = zodObjectFromJsonSchema({
      allOf: [
        { properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } },
        { properties: { b: { type: 'number' } }, additionalProperties: false },
      ],
    });
    expect(strictMerged.safeParse({ a: 'ok', b: 1 }).success).toBe(true);
    expect(strictMerged.safeParse({ a: 'ok', extra: 5 }).success).toBe(false);
  });

  test('zodOutputFromJsonSchema handles readOnly: true and preserves patternProperties + additionalProperties: false on MCP re-export', async () => {
    const readOnlyOutput = zodOutputFromJsonSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      readOnly: true,
    });
    expect(readOnlyOutput.safeParse({ a: 'ok' }).success).toBe(true);
    expect(readOnlyOutput.safeParse({}).success).toBe(false);
    expect(readOnlyOutput.safeParse({ a: 1 }).success).toBe(false);

    const outputSchema = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      patternProperties: { '^x_': { type: 'number' } },
      additionalProperties: false,
    };
    const recovered = zodOutputFromJsonSchema(outputSchema);
    expect(recovered.safeParse({ id: '1', x_n: 5 }).success).toBe(true);
    expect(recovered.safeParse({ id: '1', x_n: 'bad' }).success).toBe(false);
    expect(recovered.safeParse({ id: '1', extra: 1 }).success).toBe(false);

    // Full MCP mount -> MCP server re-export round-trip
    const mounted = await mountMcpSchema(
      { type: 'object', properties: { q: { type: 'string' } } },
      ['MCP'],
      outputSchema,
    );
    expect(mounted.skipped).toEqual([]);
    if (!mounted.tool) throw new Error('Expected MCP tool with patternProperties output');

    const mcpServer = buildMcpServer({
      serverInfo: { name: 'reexport-output', version: '1.0.0' },
      access: { open: 'local-operator' },
      services: [],
      runtimeTools: [mounted.tool],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const listedTool = listed.tools.find((entry) => entry.name === 'probe');
      expect(listedTool).toBeDefined();
      const listedOutput = listedTool?.outputSchema;
      if (!isRecord(listedOutput)) throw new Error('Expected listed outputSchema');
      expect(listedOutput.type).toBe('object');
      expect(listedOutput.properties).toEqual({ id: { type: 'string' } });
      expect(listedOutput.required).toEqual(['id']);
      expect(listedOutput.patternProperties).toEqual({ '^x_': { type: 'number' } });
      expect(listedOutput.additionalProperties).toBe(false);
    } finally {
      await client.close();
    }
  });
});
