import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineRuntimeTool, defineToolRegistry, mountAgent } from '../src/tools';

function fake(name: string) {
  return defineRuntimeTool({
    name,
    description: `${name} tool`,
    identity: { serviceName: 'test', action: name, method: 'POST' },
    input: z.object({}).strict(),
    output: z.object({ from: z.string() }).strict(),
    handler: () => ({ from: name }),
  });
}

const defaults = [fake('bash'), fake('read_file'), fake('web_search')];

describe('tool registry', () => {
  test('build returns exactly the composed surface, replacements first-class', () => {
    const replacement = fake('bash');
    const registry = defineToolRegistry({ defaults })
      .replace('bash', replacement)
      .disable('web_search')
      .build();
    expect(registry.names).toEqual(['bash', 'read_file']);
    expect(registry.tools[0]).toBe(replacement);
  });

  test('disable is idempotent and unknown names are refused', () => {
    const registry = defineToolRegistry({ defaults })
      .disable('web_search')
      .disable('web_search')
      .build();
    expect(registry.names).toEqual(['bash', 'read_file']);
    expect(() => defineToolRegistry({ defaults }).disable('web_serch')).toThrow(
      /names no default/,
    );
    expect(() => defineToolRegistry({ defaults }).replace('nope', fake('nope'))).toThrow(
      /names no default/,
    );
  });

  test('a replacement must occupy the same name, and only once', () => {
    expect(() => defineToolRegistry({ defaults }).replace('bash', fake('other'))).toThrow(
      /must carry that name/,
    );
    expect(() =>
      defineToolRegistry({ defaults })
        .replace('bash', fake('bash'))
        .replace('bash', fake('bash')),
    ).toThrow(/already replaced/);
  });

  test('duplicate default and composed names are refused', () => {
    expect(() => defineToolRegistry({ defaults: [fake('x'), fake('x')] })).toThrow(
      /Duplicate default tool name/,
    );
  });

  test('mountAgent accepts the registry and refuses two surface declarations', () => {
    const registry = defineToolRegistry({ defaults }).disable('web_search').build();
    const tools = mountAgent([], { registry });
    expect(Object.keys(tools).sort()).toEqual(['bash', 'read_file']);
    expect(() => mountAgent([], { registry, runtimeTools: [fake('bash')] })).toThrow(
      /either runtimeTools or a registry/,
    );
  });
});
