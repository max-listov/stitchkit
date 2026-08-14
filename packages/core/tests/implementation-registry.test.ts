import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/contract';
import {
  createImplementRegistry,
  implementRegistry,
  type RegistryHandlers,
} from '../src/server';

const IdParamsSchema = z.object({ id: z.string() });
const UserSchema = z.object({ id: z.string(), name: z.string() });
const UsersSchema = z.array(UserSchema);
const PostSchema = z.object({ id: z.string(), title: z.string() });

const users = defineContract(
  { prefix: 'users', scope: 'user' },
  {
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get user',
      params: IdParamsSchema,
      output: UserSchema,
      expose: ['HTTP'],
    },
  },
);

const posts = defineContract(
  { prefix: 'posts', scope: 'user' },
  {
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get post',
      params: IdParamsSchema,
      output: PostSchema,
      expose: ['HTTP'],
    },
  },
);

const registry = { users, posts };

describe('implementRegistry', () => {
  test('binds every contract in deterministic registry order', () => {
    const services = implementRegistry(registry, {
      users: { get: ({ params }) => ({ id: params.id, name: 'Ada' }) },
      posts: { get: ({ params }) => ({ id: params.id, title: 'Types' }) },
    });

    expect(services.map((service) => service.name)).toEqual(['users', 'posts']);
    expect(Object.keys(services[0]?.methods ?? {})).toEqual(['get']);
    expect(Object.keys(services[1]?.methods ?? {})).toEqual(['get']);
  });

  test('fixes one typed context for the whole registry', () => {
    interface AppContext extends RuntimeContext {
      tenantId: string;
    }
    const implementAppRegistry = createImplementRegistry<AppContext>();
    const services = implementAppRegistry(registry, {
      users: {
        get: ({ params, tenantId }) => ({ id: params.id, name: tenantId }),
      },
      posts: {
        get: ({ params, tenantId }) => ({ id: params.id, title: tenantId }),
      },
    });
    expect(services).toHaveLength(2);
  });

  test('fails first for loose callers with missing, extra or duplicate entries', () => {
    const call = (contracts: unknown, handlers: unknown): unknown =>
      Reflect.apply(implementRegistry, undefined, [contracts, handlers]);
    expect(() =>
      call(registry, {
        users: { get: () => ({ id: '1', name: 'Ada' }) },
      }),
    ).toThrow('missing: posts');
    expect(() =>
      call(registry, {
        users: { get: () => ({ id: '1', name: 'Ada' }) },
        posts: { get: () => ({ id: '1', title: 'Types' }) },
        extra: {},
      }),
    ).toThrow('extra: extra');
    expect(() =>
      call(registry, {
        users: {},
        posts: { get: () => ({ id: '1', title: 'Types' }) },
      }),
    ).toThrow('handlers for "users" mismatch (missing: get; extra: none)');
    expect(() =>
      call(registry, {
        users: {
          get: () => ({ id: '1', name: 'Ada' }),
          extra: () => undefined,
        },
        posts: { get: () => ({ id: '1', title: 'Types' }) },
      }),
    ).toThrow('handlers for "users" mismatch (missing: none; extra: extra)');
    expect(() => call({ composed: [users] }, { composed: {} })).toThrow(
      'composed arrays and namespaces are not supported',
    );

    const duplicatePrefix = defineContract(
      { prefix: 'users', scope: 'user' },
      {
        list: {
          method: 'GET',
          path: '/',
          desc: 'List users',
          output: UsersSchema,
          expose: ['HTTP'],
        },
      },
    );
    expect(() =>
      call(
        { users, duplicatePrefix },
        {
          users: { get: () => ({ id: '1', name: 'Ada' }) },
          duplicatePrefix: { list: () => [] },
        },
      ),
    ).toThrow('duplicate contract prefix "users"');
  });
});

function assertRegistryTypes(): void {
  // Public compile fixtures: registry keys and endpoint handlers are exact.
  // @ts-expect-error posts implementation is required
  implementRegistry(registry, {
    users: { get: ({ params }) => ({ id: params.id, name: 'Ada' }) },
  });

  implementRegistry(registry, {
    users: {
      get: ({ params }) => ({ id: params.id, name: 'Ada' }),
      // @ts-expect-error contract does not declare an extra endpoint handler
      extra: () => undefined,
    },
    posts: { get: ({ params }) => ({ id: params.id, title: 'Types' }) },
  });

  implementRegistry(registry, {
    // @ts-expect-error every contract endpoint requires an implementation
    users: {},
    posts: { get: ({ params }) => ({ id: params.id, title: 'Types' }) },
  });

  implementRegistry(registry, {
    users: { get: ({ params }) => ({ id: params.id, name: 'Ada' }) },
    posts: { get: ({ params }) => ({ id: params.id, title: 'Types' }) },
    // @ts-expect-error registry does not declare an extra service
    extra: {},
  });

  implementRegistry(registry, {
    users: {
      // @ts-expect-error user handler must return the declared user output
      get: ({ params }) => ({ id: params.id, title: 'wrong output' }),
    },
    posts: { get: ({ params }) => ({ id: params.id, title: 'Types' }) },
  });

  const exactHandlers: RegistryHandlers<typeof registry> = {
    users: { get: ({ params }) => ({ id: params.id, name: 'Ada' }) },
    posts: { get: ({ params }) => ({ id: params.id, title: 'Types' }) },
  };
  implementRegistry(registry, exactHandlers);
}

void assertRegistryTypes;
