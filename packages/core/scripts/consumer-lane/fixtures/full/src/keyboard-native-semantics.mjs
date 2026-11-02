import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The source regression supplies its entrypoint; installed proofs use only the public package.
const { useNavZone } = await import(process.argv[2] ?? 'stitchkit/react/keyboard');

function Zone({ role, orientation }) {
  const zone = useNavZone({ items: ['link', 'button'], role, orientation, mode: 'focus' });
  if (role === 'none') {
    assert.equal(Object.hasOwn(zone.zoneProps, 'role'), false);
    assert.equal(Object.hasOwn(zone.zoneProps, 'aria-orientation'), false);
  }
  return createElement(
    'div',
    zone.zoneProps,
    createElement('a', { href: '#destination', ...zone.itemProps('link') }, 'Link'),
    createElement('button', { type: 'button', ...zone.itemProps('button') }, 'Button'),
  );
}

for (const orientation of [undefined, 'vertical', 'horizontal']) {
  const native = renderToStaticMarkup(createElement(Zone, { role: 'none', orientation }));
  assert.doesNotMatch(native, /aria-orientation|role=|aria-selected/);
  assert.match(native, /<a href="#destination" tabindex="0">Link<\/a>/);
  assert.match(native, /<button type="button" tabindex="-1">Button<\/button>/);
  for (const role of [undefined, 'listbox', 'tablist']) {
    const html = renderToStaticMarkup(createElement(Zone, { role, orientation }));
    assert.ok(html.includes(`role="${role ?? 'listbox'}"`));
    assert.ok(html.includes(`aria-orientation="${orientation ?? 'vertical'}"`));
    assert.ok(html.includes(`role="${role === 'tablist' ? 'tab' : 'option'}"`));
    assert.ok(html.includes('aria-selected="false"'));
  }
}
console.log('packed keyboard native semantics: ok');
