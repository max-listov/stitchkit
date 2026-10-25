import { expect, test } from 'bun:test';
import { type ClickTarget, resolveTrackedClick } from '../src/tracking/clicks';

const origin = 'https://shop.example';
function link(href: string, attrs: Record<string, string> = {}): ClickTarget {
  return {
    closest(selector) {
      return selector === 'a[href]' || selector.includes('data-t') ? this : null;
    },
    getAttribute: (name) => ({ href, 'data-track': 'product', ...attrs })[name] ?? null,
    textContent: '  Product label  ',
  };
}

test('hrefPolicy retains internal and outbound query and fragment only when full', () => {
  for (const [input, path, full] of [
    ['/item?offer=one&offer=two#details', '/item', '/item?offer=one&offer=two#details'],
    ['https://shop.example/item?q=%2F#part', '/item', '/item?q=%2F#part'],
    [
      '//outside.example/item?q=one#part',
      'https://outside.example/item',
      'https://outside.example/item?q=one#part',
    ],
    [
      'https://example-user:example-password@outside.example/item?q=one#part',
      'https://outside.example/item',
      'https://outside.example/item?q=one#part',
    ],
    ['/item', '/item', '/item'],
  ]) {
    if (!input) throw new Error('Missing input');
    const target = link(input);
    expect(resolveTrackedClick(target, { origin })?.click?.href).toBe(path);
    expect(resolveTrackedClick(target, { origin, hrefPolicy: 'path-only' })?.click?.href).toBe(
      path,
    );
    const result = resolveTrackedClick(target, { origin, hrefPolicy: 'full' });
    expect(result?.click).toEqual({
      element: 'product',
      elementText: 'Product label',
      href: full,
    });
    expect(result?.leavesPage).toBe(true);
    if (input.includes('outside.example')) expect(result?.outbound?.href).toBe(full);
  }
});

test('click origin attributes and action predicate retain their meanings with full URLs', () => {
  expect(
    resolveTrackedClick(link('/item?q=x#p', { 'data-t': 'custom' }), {
      origin,
      attributes: { track: 'data-t' },
      hrefPolicy: 'full',
    })?.click?.element,
  ).toBe('custom');
  const target = link('/item?q=x#p', { 'data-track-action': 'buy' });
  expect(resolveTrackedClick(target, { origin, hrefPolicy: 'full' })?.interaction).toEqual({
    action: 'buy',
    context: undefined,
  });
  expect(
    resolveTrackedClick(target, { origin, hrefPolicy: 'full', isAction: () => false })?.click
      ?.href,
  ).toBe('/item?q=x#p');
  expect(resolveTrackedClick(null, { origin, hrefPolicy: 'full' })).toBeNull();
  const invalid = resolveTrackedClick(link('http://['), { origin, hrefPolicy: 'full' });
  expect(invalid?.click?.href).toBeUndefined();
  expect(invalid?.leavesPage).toBe(false);
  expect(
    resolveTrackedClick(link('https://shop.example/item?q=x'), {
      origin: 'https://other.example',
      hrefPolicy: 'full',
    })?.outbound?.href,
  ).toBe('https://shop.example/item?q=x');
});
