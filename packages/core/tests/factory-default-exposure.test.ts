import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createCli } from '../src/entrypoints/cli';
import { createContractFactory } from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';
import { listToolNames, summarizeTransports } from '../src/entrypoints/tools';

const TextSchema = z.string();

describe('factory default exposure', () => {
  test('configured default exposure drives HTTP, CLI and the transport manifest', async () => {
    const { defineContract } = createContractFactory<'public'>().configure({
      toolExposure: { default: ['HTTP', 'CLI'] },
    });
    const contract = defineContract(
      { prefix: 'factory', scope: 'public' },
      {
        read: { method: 'GET', path: '/', desc: 'Read', output: TextSchema },
        download: {
          method: 'GET',
          path: '/download',
          desc: 'Download',
          rawResponse: true,
        },
        restricted: {
          method: 'GET',
          path: '/restricted',
          desc: 'Read through HTTP',
          expose: ['HTTP'],
          output: TextSchema,
        },
      },
    );
    let calls = 0;
    const service = implement(contract, {
      read: () => {
        calls += 1;
        return 'read';
      },
      download: () => new Response('download'),
      restricted: () => 'restricted',
    });
    expect(contract.endpoints.read.expose).toEqual(['HTTP', 'CLI']);
    expect(contract.endpoints.download.expose).toEqual(['HTTP']);
    expect(contract.endpoints.restricted.expose).toEqual(['HTTP']);
    expect(listToolNames({ services: [service] })).toEqual([
      {
        kind: 'contract',
        name: 'read_factory',
        service: 'factory',
        method: 'read',
        transports: ['CLI'],
      },
    ]);
    expect(summarizeTransports({ services: [service] }).totals).toEqual({
      HTTP: 3,
      MCP: 0,
      AGENT: 0,
      CLI: 1,
    });
    const handler = createHandler({ services: [service] });
    expect((await handler(new Request('http://localhost/factory/'))).status).toBe(200);
    let output = '';
    let exitCode = -1;
    await createCli({
      name: 'factory',
      version: '1.0.0',
      services: [service],
      argv: ['read_factory', '--json'],
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        throw new Error(text);
      },
      exit: (code) => {
        exitCode = code;
      },
      stdin: async () => null,
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toBe('read');
    expect(calls).toBe(2);
  });
});
