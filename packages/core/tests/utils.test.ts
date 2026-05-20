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
  test('merges params + input into single schema', () => {
    const params = z.object({ id: z.string() });
    const input = z.object({ name: z.string() });
    const merged = mergeSchemas(params, input);

    const result = merged.parse({ id: '123', name: 'test' });
    expect(result).toEqual({ id: '123', name: 'test' });
  });

  test('params only', () => {
    const params = z.object({ id: z.string() });
    const merged = mergeSchemas(params, undefined);
    expect(merged.parse({ id: 'abc' })).toEqual({ id: 'abc' });
  });

  test('input only', () => {
    const input = z.object({ name: z.string() });
    const merged = mergeSchemas(undefined, input);
    expect(merged.parse({ name: 'test' })).toEqual({ name: 'test' });
  });

  test('neither — empty schema', () => {
    const merged = mergeSchemas(undefined, undefined);
    expect(merged.parse({})).toEqual({});
  });

  test('JSON coercion — string to array', () => {
    const input = z.object({ tags: z.array(z.string()) });
    const merged = mergeSchemas(undefined, input);
    const result = merged.parse({ tags: '["a","b"]' });
    expect(result).toEqual({ tags: ['a', 'b'] });
  });

  test('JSON coercion — string to object', () => {
    const input = z.object({ meta: z.object({ key: z.string() }) });
    const merged = mergeSchemas(undefined, input);
    const result = merged.parse({ meta: '{"key":"val"}' });
    expect(result).toEqual({ meta: { key: 'val' } });
  });

  test('conflict detection — throws on duplicate keys', () => {
    const params = z.object({ id: z.string() });
    const input = z.object({ id: z.number(), name: z.string() });
    expect(() => mergeSchemas(params, input)).toThrow('Schema merge conflict: id');
  });

  test('discriminated union — flattened to flat object', () => {
    const input = z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), content: z.string() }),
      z.object({ type: z.literal('image'), url: z.string(), alt: z.string().optional() }),
    ]);

    const merged = mergeSchemas(undefined, input);
    const shape = merged.shape;

    expect('type' in shape).toBe(true);
    expect('content' in shape).toBe(true);
    expect('url' in shape).toBe(true);
    expect('alt' in shape).toBe(true);

    expect(merged.parse({ type: 'text', content: 'hello' })).toBeTruthy();
    expect(merged.parse({ type: 'image', url: 'http://...' })).toBeTruthy();
  });

  test('discriminated union + params merged', () => {
    const params = z.object({ id: z.string() });
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.literal('create'), name: z.string() }),
      z.object({ action: z.literal('delete') }),
    ]);

    const merged = mergeSchemas(params, input);
    expect('id' in merged.shape).toBe(true);
    expect('action' in merged.shape).toBe(true);
    expect('name' in merged.shape).toBe(true);
  });
});
