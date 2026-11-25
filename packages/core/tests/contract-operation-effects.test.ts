import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type ContractDef,
  contractOperationEffects,
  createContractFactory,
  defineContract,
  type OperationEffect,
  OperationEffectSchema,
  requireContractOperationEffects,
} from '../src/entrypoints/contract';
import * as rootEntry from '../src/entrypoints/index';

describe('contract operation effects', () => {
  test('OperationEffectSchema accepts strictly read and write and rejects unknown values', () => {
    expect(OperationEffectSchema.parse('read')).toBe('read');
    expect(OperationEffectSchema.parse('write')).toBe('write');

    for (const invalid of ['delete', 'mutate', 'admin', 'READ', '', null, undefined, 42, {}]) {
      expect(OperationEffectSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('defineContract preserves backwards compatibility when effect is omitted', () => {
    const legacy = defineContract(
      { prefix: 'items' },
      {
        list: {
          method: 'GET',
          path: '/',
          desc: 'List items',
          output: z.array(z.string()),
        },
        create: {
          method: 'POST',
          path: '/',
          desc: 'Create item',
          input: z.strictObject({ name: z.string() }),
        },
      },
    );

    expect(contractOperationEffects(legacy)).toEqual({});
  });

  test('defineContract accepts effect on all endpoint variants and rejects invalid values', () => {
    const contract = defineContract(
      { prefix: 'records' },
      {
        get: {
          method: 'GET',
          path: '/:id',
          desc: 'Get one record',
          effect: 'read',
        },
        probe: {
          method: 'HEAD',
          path: '/:id',
          desc: 'Probe record existence',
          rawResponse: true,
          effect: 'read',
        },
        update: {
          method: 'POST',
          path: '/:id',
          desc: 'Update record',
          input: z.strictObject({ value: z.string() }),
          effect: 'write',
        },
        events: {
          method: 'GET',
          path: '/events',
          desc: 'Stream record events',
          stream: { item: z.strictObject({ seq: z.number() }) },
          effect: 'read',
        },
      },
    );

    const effects: Record<'get' | 'probe' | 'update' | 'events', OperationEffect> =
      requireContractOperationEffects(contract);
    expect(effects).toEqual({
      get: 'read',
      probe: 'read',
      update: 'write',
      events: 'read',
    });

    // Reject unknown runtime values at defineContract time
    const badEndpoints = JSON.parse(
      '{"remove":{"method":"DELETE","path":"/:id","desc":"Delete record","effect":"admin"}}',
    );
    expect(() => defineContract({ prefix: 'records' }, badEndpoints)).toThrow(
      /invalid effect "admin"/i,
    );
  });

  test('contractOperationEffects projects declared effects and omits undeclared ones', () => {
    const mixed = defineContract(
      { prefix: 'tasks' },
      {
        list: { method: 'GET', path: '/', desc: 'List tasks', effect: 'read' },
        create: { method: 'POST', path: '/', desc: 'Create task', effect: 'write' },
        ping: { method: 'GET', path: '/ping', desc: 'Health check' },
      },
    );

    const partial = contractOperationEffects(mixed);
    expect(partial).toEqual({ list: 'read', create: 'write' });
    expect('ping' in partial).toBe(false);
  });

  test('requireContractOperationEffects fails closed and lists all missing operation names', () => {
    const incomplete = defineContract(
      { prefix: 'control' },
      {
        status: { method: 'GET', path: '/status', desc: 'Read status', effect: 'read' },
        restart: { method: 'POST', path: '/restart', desc: 'Restart worker' },
        drain: { method: 'POST', path: '/drain', desc: 'Drain worker' },
      },
    );

    expect(() => requireContractOperationEffects(incomplete)).toThrow(
      /control.*restart.*drain/,
    );
  });

  test('projection helpers reject invalid effect values on hand-assembled contracts', () => {
    const handAssembled: ContractDef = {
      meta: { prefix: 'raw' },
      endpoints: JSON.parse(
        '{"run":{"method":"POST","path":"/x","desc":"Bad effect","effect":"execute"}}',
      ),
    };

    expect(() => contractOperationEffects(handAssembled)).toThrow(/invalid effect "execute"/i);
    expect(() => requireContractOperationEffects(handAssembled)).toThrow(
      /invalid effect "execute"/i,
    );
  });

  test('works through createContractFactory and is re-exported from root entrypoint', () => {
    const factory = createContractFactory<'reader' | 'writer'>().configure({
      toolExposure: { default: ['HTTP'] },
    });
    const scoped = factory.defineContract(
      { prefix: 'kv', scope: 'reader' },
      {
        get: { method: 'GET', path: '/:key', desc: 'Read key', effect: 'read' },
        set: {
          method: 'PUT',
          path: '/:key',
          desc: 'Write key',
          scope: 'writer',
          effect: 'write',
        },
      },
    );

    expect(requireContractOperationEffects(scoped)).toEqual({
      get: 'read',
      set: 'write',
    });

    expect(rootEntry.OperationEffectSchema).toBe(OperationEffectSchema);
    expect(rootEntry.contractOperationEffects).toBe(contractOperationEffects);
    expect(rootEntry.requireContractOperationEffects).toBe(requireContractOperationEffects);
  });

  test('supports empty contracts, multipart endpoints, and non-HEAD rawResponse endpoints', () => {
    const empty = defineContract({ prefix: 'empty' }, {});
    expect(contractOperationEffects(empty)).toEqual({});
    expect(requireContractOperationEffects(empty)).toEqual({});

    const filesContract = defineContract(
      { prefix: 'files' },
      {
        download: {
          method: 'GET',
          path: '/:id',
          desc: 'Download raw file',
          rawResponse: true,
          contentType: 'application/octet-stream',
          effect: 'read',
        },
        upload: {
          method: 'POST',
          path: '/upload',
          desc: 'Upload file via multipart',
          multipart: {
            files: {
              file: { maxBytes: 1024 },
            },
          },
          effect: 'write',
        },
      },
    );

    expect(requireContractOperationEffects(filesContract)).toEqual({
      download: 'read',
      upload: 'write',
    });
  });
});
