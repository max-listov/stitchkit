import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AppError,
  badRequest,
  defineContract,
  forbidden,
  notFound,
  unauthorized,
} from '../src/contract';

const ListOutputSchema = z.array(z.string());
const CreateInputSchema = z.object({ name: z.string() });
const CreateOutputSchema = z.object({ id: z.string() });

describe('defineContract', () => {
  test('creates contract with prefix and endpoints', () => {
    const contract = defineContract(
      { prefix: 'users' },
      {
        list: { method: 'GET', path: '/', desc: 'List users', output: ListOutputSchema },
        create: {
          method: 'POST',
          path: '/',
          desc: 'Create user',
          input: CreateInputSchema,
          output: CreateOutputSchema,
        },
      },
    );

    expect(contract.meta.prefix).toBe('users');
    expect(contract.meta.scope).toBeUndefined();
    expect(contract.endpoints.list.method).toBe('GET');
    expect(contract.endpoints.create.method).toBe('POST');
  });

  test('creates contract with scope', () => {
    const contract = defineContract(
      { prefix: 'admin', scope: 'admin' },
      {
        stats: { method: 'GET', path: '/stats', desc: 'Get stats' },
      },
    );

    expect(contract.meta.scope).toBe('admin');
  });

  test('detects duplicate toolNames on same transport', () => {
    expect(() =>
      defineContract(
        { prefix: 'test' },
        {
          a: { method: 'GET', path: '/a', desc: 'A', toolName: 'do_thing' },
          b: { method: 'POST', path: '/b', desc: 'B', toolName: 'do_thing' },
        },
      ),
    ).toThrow('duplicate toolName');
  });

  test('allows same toolName on different transports', () => {
    expect(() =>
      defineContract(
        { prefix: 'test' },
        {
          a: {
            method: 'GET',
            path: '/a',
            desc: 'A',
            toolName: 'do_thing',
            expose: ['HTTP'] as const,
          },
          b: {
            method: 'POST',
            path: '/b',
            desc: 'B',
            toolName: 'do_thing',
            expose: ['MCP'] as const,
          },
        },
      ),
    ).not.toThrow();
  });

  test('supports endpoint-level scope override', () => {
    const contract = defineContract(
      { prefix: 'mixed', scope: 'auth' },
      {
        public: { method: 'GET', path: '/health', desc: 'Health', scope: 'public' },
        protected: { method: 'GET', path: '/me', desc: 'Profile' },
      },
    );

    expect(contract.endpoints.public.scope).toBe('public');
    expect('scope' in contract.endpoints.protected).toBe(false);
    expect(contract.meta.scope).toBe('auth');
  });
});

describe('AppError', () => {
  test('creates error with code and status', () => {
    const err = new AppError('NOT_FOUND', 'User not found', 404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('User not found');
    expect(err.status).toBe(404);
    expect(AppError.is(err)).toBe(true);
  });

  test('toJSON serializes correctly', () => {
    const err = new AppError('BAD_REQUEST', 'Invalid', 400, { field: 'name' });
    const json = err.toJSON();
    expect(json.error.code).toBe('BAD_REQUEST');
    expect(json.error.details).toEqual({ field: 'name' });
  });

  test('is() returns false for non-AppError', () => {
    expect(AppError.is(new Error('test'))).toBe(false);
    expect(AppError.is('string')).toBe(false);
    expect(AppError.is(null)).toBe(false);
  });
});

describe('error helpers', () => {
  /** Run a throwing helper, return the caught value — `undefined` if it did not throw. */
  function captureThrow(fn: () => void): unknown {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  test('notFound throws 404', () => {
    const e = captureThrow(() => notFound());
    expect(AppError.is(e)).toBe(true);
    if (!AppError.is(e)) return;
    expect(e.code).toBe('NOT_FOUND');
    expect(e.status).toBe(404);
  });

  test('badRequest throws 400', () => {
    const e = captureThrow(() => badRequest('Bad', { field: 'x' }));
    expect(AppError.is(e)).toBe(true);
    if (!AppError.is(e)) return;
    expect(e.status).toBe(400);
    expect(e.details).toEqual({ field: 'x' });
  });

  test('unauthorized throws 401', () => {
    const e = captureThrow(() => unauthorized());
    expect(AppError.is(e)).toBe(true);
    if (!AppError.is(e)) return;
    expect(e.status).toBe(401);
  });

  test('forbidden throws 403', () => {
    const e = captureThrow(() => forbidden());
    expect(AppError.is(e)).toBe(true);
    if (!AppError.is(e)) return;
    expect(e.status).toBe(403);
  });
});
