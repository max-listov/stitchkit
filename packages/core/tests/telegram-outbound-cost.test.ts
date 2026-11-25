/**
 * The outbound budget fails closed.
 *
 * A method the budget did not know cost nothing, so a bot calling a send
 * method Telegram added after this list was written sent past its budget into
 * flood waits. Now every method grammY's types name is classified as a send or
 * as free, and a method nobody classified costs one.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OUTBOUND_METHOD_CLASSES, sendCost } from '../src/telegram/outbound-cost';

/** Method names and property aliases grammY's own `ApiMethods` type declares. */
function grammyMethods(): string[] {
  const grammy = dirname(Bun.resolveSync('grammy/package.json', import.meta.dir));
  const types = Bun.resolveSync('@grammyjs/types/methods.d.ts', grammy);
  const source = readFileSync(types, 'utf8');
  const start = source.indexOf('export type ApiMethods<F> = {');
  const rawBody = source.slice(start, source.indexOf('\n};', start));
  // Strip JSDoc blocks so prose lines like `Example:` inside comments never masquerade as aliases.
  const body = rawBody.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...new Set([...body.matchAll(/^ {4}(\w+)[(:]/gm)].map((match) => match[1] ?? ''))];
}

test('every method and alias grammY knows is a send or free, never both', () => {
  const methods = grammyMethods();
  expect(methods.length).toBeGreaterThan(150);
  expect(methods).toContain('kickChatMember');
  expect(methods).toContain('getChatMembersCount');
  const { send, free } = OUTBOUND_METHOD_CLASSES;
  expect(methods.filter((method) => !send.has(method) && !free.has(method))).toEqual([]);
  expect([...send].filter((method) => free.has(method))).toEqual([]);
});

test('an unknown method costs one; a free one (including aliases) nothing; a weighted send its length', () => {
  expect(sendCost('sendHologram', { chat_id: 1 })).toBe(1);
  expect(sendCost('getMe', undefined)).toBe(0);
  expect(sendCost('kickChatMember', { chat_id: 1 })).toBe(0);
  expect(sendCost('getChatMembersCount', { chat_id: 1 })).toBe(0);
  expect(sendCost('approveSuggestedPost', { chat_id: 1 })).toBe(0);
  expect(sendCost('editMessageText', { chat_id: 1 })).toBe(0);
  expect(sendCost('sendChatAction', { chat_id: 1 })).toBe(0);
  expect(sendCost('sendMediaGroup', { media: [1, 2, 3] })).toBe(3);
});
