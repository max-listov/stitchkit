import { describe, expect, test } from 'bun:test';
import { readAgentConfig } from '../src/config';

describe('agent config', () => {
  test('requires only an OpenRouter credential and accepts an optional preferred model', () => {
    expect(() => readAgentConfig({})).toThrow(
      'Missing or invalid configuration: OPENROUTER_API_KEY',
    );
    expect(readAgentConfig({ OPENROUTER_API_KEY: 'secret' })).toEqual({ apiKey: 'secret' });
    expect(
      readAgentConfig({
        OPENROUTER_API_KEY: 'secret',
        OPENROUTER_MODEL: 'provider/model',
      }),
    ).toEqual({ apiKey: 'secret', preferredModelId: 'provider/model' });
  });
});
