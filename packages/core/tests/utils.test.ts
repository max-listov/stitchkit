import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { toToolName } from '../src/tools/names';
import { mergeSchemas } from '../src/tools/schema';

describe('toToolName', () => {
  test('list → list_users', () => {
    expect(toToolName('users', 'list')).toBe('list_users');
  });

  test('get → get_user (singularized)', () => {
    expect(toToolName('users', 'get')).toBe('get_user');
  });

  test('create → create_user', () => {
    expect(toToolName('users', 'create')).toBe('create_user');
  });

  test('delete → delete_user', () => {
    expect(toToolName('users', 'delete')).toBe('delete_user');
  });

  test('custom method → snake_case_singular', () => {
    expect(toToolName('users', 'togglePin')).toBe('toggle_pin_user');
  });

  test('news stays news (exception)', () => {
    expect(toToolName('news', 'list')).toBe('list_news');
    expect(toToolName('news', 'get')).toBe('get_news');
  });

  test('analytics stays analytics (exception)', () => {
    expect(toToolName('analytics', 'get')).toBe('get_analytics');
  });

  test('hyphenated service name', () => {
    expect(toToolName('bot-links', 'list')).toBe('list_bot_links');
  });

  test('activities → activity (ies → y)', () => {
    expect(toToolName('activities', 'get')).toBe('get_activity');
    expect(toToolName('activities', 'list')).toBe('list_activities');
  });

  test('categories → category (ies → y)', () => {
    expect(toToolName('categories', 'create')).toBe('create_category');
  });

  test('status exception — stays status', () => {
    expect(toToolName('status', 'get')).toBe('get_status');
  });

  test('settings exception — stays settings', () => {
    expect(toToolName('settings', 'update')).toBe('update_settings');
  });

  test('media exception — stays media', () => {
    expect(toToolName('media', 'get')).toBe('get_media');
  });

  test('progress exception — stays progress', () => {
    expect(toToolName('progress', 'get')).toBe('get_progress');
  });
});

describe('mergeSchemas', () => {
  test('merges params + input into a single object schema', () => {
    const merged = mergeSchemas(z.object({ id: z.string() }), z.object({ name: z.string() }));
    expect(merged.parse({ id: '123', name: 'test' })).toEqual({
      id: '123',
      name: 'test',
    });
  });

  test('params only', () => {
    const merged = mergeSchemas(z.object({ id: z.string() }), undefined);
    expect(merged.parse({ id: 'abc' })).toEqual({ id: 'abc' });
  });

  test('input only', () => {
    const merged = mergeSchemas(undefined, z.object({ name: z.string() }));
    expect(merged.parse({ name: 'test' })).toEqual({ name: 'test' });
  });

  test('neither — empty schema', () => {
    expect(mergeSchemas(undefined, undefined).parse({})).toEqual({});
  });

  test('does not coerce — the advertised schema is the validated schema', () => {
    // Coercion would make the schema a tool advertises differ from the one a
    // call is validated against. A JSON-looking string is rejected, not parsed.
    const merged = mergeSchemas(undefined, z.object({ tags: z.array(z.string()) }));
    expect(() => merged.parse({ tags: '["a","b"]' })).toThrow();
    expect(merged.parse({ tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] });
  });

  test('conflict detection — throws on a key in both params and input', () => {
    expect(() =>
      mergeSchemas(z.object({ id: z.string() }), z.object({ id: z.number() })),
    ).toThrow('Schema merge conflict: id');
  });

  test('non-object params — throws', () => {
    expect(() => mergeSchemas(z.string(), undefined)).toThrow(
      'params schema must be a z.object',
    );
  });

  test('discriminated union input — kept intact, requiredness preserved', () => {
    const merged = mergeSchemas(
      undefined,
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), content: z.string() }),
        z.object({ type: z.literal('image'), url: z.string() }),
      ]),
    );
    expect(merged.parse({ type: 'text', content: 'hello' })).toBeTruthy();
    expect(merged.parse({ type: 'image', url: 'http://x' })).toBeTruthy();
    // A wrong-variant field combination is still rejected.
    expect(() => merged.parse({ type: 'text', url: 'http://x' })).toThrow();
  });

  test('discriminated union + params — intersected, both enforced', () => {
    const merged = mergeSchemas(
      z.object({ id: z.string() }),
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('create'), name: z.string() }),
        z.object({ action: z.literal('delete') }),
      ]),
    );
    expect(merged.parse({ id: 'x', action: 'create', name: 'n' })).toBeTruthy();
    expect(merged.parse({ id: 'x', action: 'delete' })).toBeTruthy();
    // Missing the params half is rejected.
    expect(() => merged.parse({ action: 'delete' })).toThrow();
  });
});
