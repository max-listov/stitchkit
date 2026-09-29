import { describe, expect, test } from 'bun:test';
import {
  decodeInput,
  decodeParams,
  encodeCallback,
  parseCallback,
  utf8Length,
} from '../src/telegram/screens/callback-codec';
import { html } from '../src/telegram/screens/html';
import { planView, type ShownMessage } from '../src/telegram/screens/reconcile';
import type { OutgoingMessage, RenderedKind } from '../src/telegram/screens/render';
import { classifyTelegramEditRefusal } from '../src/telegram/send-failure';

describe('callback codec', () => {
  test('round-trips params and typed input, compacting UUIDs', () => {
    const uuid = '0f8a9b1c-2d3e-4f50-8a6b-7c8d9e0f1a2b';
    const body = encodeCallback({
      screen: 'ab12cd',
      action: 'pick',
      params: [uuid, 'a:b%c', '~tilde', 7],
      input: { z: true, a: null, n: -1.5, s: 'Привет', skip: undefined },
    });
    expect(body.includes(uuid)).toBe(false);
    const parsed = parseCallback(body);
    expect(parsed?.kind).toBe('address');
    if (parsed?.kind !== 'address') return;
    expect(parsed).toMatchObject({ screen: 'ab12cd', action: 'pick', detached: false });
    expect(decodeParams(parsed.segments.slice(0, 4))).toEqual([uuid, 'a:b%c', '~tilde', 7]);
    expect(decodeInput(parsed.segments.slice(4))).toEqual({
      a: null,
      n: -1.5,
      s: 'Привет',
      z: true,
    });
  });

  test('a UUID param costs 24 bytes, not 36', () => {
    const uuid = '0f8a9b1c-2d3e-4f50-8a6b-7c8d9e0f1a2b';
    expect(utf8Length(encodeCallback({ screen: 'ab12cd', params: [uuid] }))).toBe(6 + 1 + 24);
  });

  test('refuses garbage, unsafe and repeated keys, and bad names', () => {
    expect(parseCallback('bad id!')).toBeNull();
    expect(parseCallback('#')).toBeNull();
    expect(decodeInput(['__proto__=~t'])).toBeNull();
    expect(decodeInput(['a=1', 'a=2'])).toBeNull();
    expect(decodeInput(['novalue'])).toBeNull();
    expect(decodeParams(['~x'])).toBeNull();
    expect(decodeParams(['%E0%A4%A'])).toBeNull();
    expect(() => encodeCallback({ screen: 'a.b', params: [] })).toThrow();
    const polluted: Record<string, number> = {};
    Object.defineProperty(polluted, '__proto__', { value: 1, enumerable: true });
    expect(() => encodeCallback({ screen: 'a', params: [], input: polluted })).toThrow();
    expect(() => encodeCallback({ screen: 'a', params: [Number.NaN] })).toThrow();
  });

  test('marks a detached button and parses a token', () => {
    expect(
      parseCallback(encodeCallback({ screen: 'x', params: [], detached: true })),
    ).toMatchObject({
      kind: 'address',
      detached: true,
    });
    expect(parseCallback('#abc123')).toEqual({ kind: 'token', token: 'abc123' });
  });
});

describe('html', () => {
  test('escapes interpolations, keeps nested markup, drops absent values', () => {
    const name = '<b>&"x"';
    const part = html`<i>${name}</i>`;
    expect(html`<b>${name}</b> ${part}${false}${null}${undefined}${3}`.toString()).toBe(
      '<b>&lt;b&gt;&amp;&quot;x&quot;</b> <i>&lt;b&gt;&amp;&quot;x&quot;</i>3',
    );
    expect(html.raw('<u>kept</u>').toString()).toBe('<u>kept</u>');
    expect(html.join(['a<', html`<b>b</b>`, null], html`<br>`).toString()).toBe(
      'a&lt;<br><b>b</b>',
    );
  });
});

function outgoing(
  key: string,
  kind: RenderedKind,
  content = key,
  markup = 'm',
): OutgoingMessage {
  return {
    key,
    kind,
    html: content,
    rich: undefined,
    linkPreview: undefined,
    media: kind === 'text' || kind === 'rich' ? undefined : `file-${content}`,
    markup: undefined,
    fingerprint: { content, media: kind === 'text' ? 'none' : `${kind}:${content}`, markup },
  };
}

function shown(id: number, message: OutgoingMessage): ShownMessage {
  return { key: message.key, id, kind: message.kind, fingerprint: message.fingerprint };
}

const ops = (plan: ReturnType<typeof planView>) =>
  plan.steps.map((step) =>
    step.op === 'send' ? `send ${step.message.key}` : `${step.op} ${step.id}`,
  );

describe('reconcile', () => {
  test('nothing changed keeps; only the keyboard changed edits only the keyboard', () => {
    const before = [shown(1, outgoing('main', 'text'))];
    expect(ops(planView(before, [outgoing('main', 'text')]))).toEqual(['keep 1']);
    const plan = planView(before, [outgoing('main', 'text', 'main', 'other')]);
    expect(plan.steps[0]).toMatchObject({
      op: 'edit',
      parts: { content: false, media: false, markup: true },
    });
  });

  test('header + body → body edits the body and deletes the header', () => {
    const before = [shown(1, outgoing('s0', 'text')), shown(2, outgoing('main', 'text'))];
    const plan = planView(before, [outgoing('main', 'text', 'new')]);
    expect(ops(plan)).toEqual(['edit 2']);
    expect(plan.deletions).toEqual([1]);
  });

  test('body → header + body sends both and deletes the old body: order holds', () => {
    const before = [shown(2, outgoing('main', 'text'))];
    const plan = planView(before, [outgoing('s0', 'text'), outgoing('main', 'text')]);
    expect(ops(plan)).toEqual(['send s0', 'send main']);
    expect(plan.deletions).toEqual([2]);
  });

  test('text into media is an edit; media into text and text into rich are new messages', () => {
    const text = [shown(1, outgoing('main', 'text'))];
    expect(planView(text, [outgoing('main', 'photo')]).steps[0]).toMatchObject({
      op: 'edit',
      parts: { media: true },
    });
    const photo = [shown(1, outgoing('main', 'photo'))];
    expect(ops(planView(photo, [outgoing('main', 'text')]))).toEqual(['send main']);
    expect(ops(planView(text, [outgoing('main', 'rich')]))).toEqual(['send main']);
    expect(planView(photo, [outgoing('main', 'video')]).steps[0]).toMatchObject({
      op: 'edit',
    });
  });

  test('rich into rich edits the text; rich into media edits the media; a new caption edits only it', () => {
    const rich = [shown(1, outgoing('main', 'rich'))];
    expect(planView(rich, [outgoing('main', 'rich', 'other')]).steps[0]).toMatchObject({
      op: 'edit',
      parts: { content: true, media: false },
    });
    expect(planView(rich, [outgoing('main', 'photo')]).steps[0]).toMatchObject({
      op: 'edit',
      parts: { media: true },
    });
    const photo = [shown(1, outgoing('main', 'photo'))];
    const recaptioned: OutgoingMessage = {
      ...outgoing('main', 'photo'),
      fingerprint: { ...outgoing('main', 'photo').fingerprint, content: 'new caption' },
    };
    expect(planView(photo, [recaptioned]).steps[0]).toMatchObject({
      op: 'edit',
      parts: { content: true, media: false, markup: false },
    });
  });

  test('an adopted message becomes the first message; fresh sends all and deletes all', () => {
    const adopted: ShownMessage = { key: 'x', id: 9, kind: 'text', fingerprint: null };
    const plan = planView([], [outgoing('main', 'text')], { adopt: adopted });
    expect(plan.steps[0]).toMatchObject({
      op: 'edit',
      id: 9,
      parts: { content: true, markup: true },
    });
    const fresh = planView([shown(1, outgoing('main', 'text'))], [outgoing('main', 'text')], {
      fresh: true,
    });
    expect(ops(fresh)).toEqual(['send main']);
    expect(fresh.deletions).toEqual([1]);
  });
});

describe('edit refusals', () => {
  test('classified from Telegram prose, wherever grammY nests it', () => {
    expect(
      classifyTelegramEditRefusal({ description: 'Bad Request: message is not modified: …' }),
    ).toBe('not-modified');
    expect(
      classifyTelegramEditRefusal(
        new Error('Call failed', {
          cause: { description: "Bad Request: message can't be edited" },
        }),
      ),
    ).toBe('message-locked');
    expect(
      classifyTelegramEditRefusal({ description: "Bad Request: message can't be deleted" }),
    ).toBe('message-locked');
    expect(
      classifyTelegramEditRefusal({
        description: 'Bad Request: there is no text in the message to edit',
      }),
    ).toBe('message-locked');
    expect(
      classifyTelegramEditRefusal({ description: 'Bad Request: message to delete not found' }),
    ).toBe('message-gone');
    expect(
      classifyTelegramEditRefusal({
        description: 'Bad Request: query is too old and response timeout expired',
      }),
    ).toBe('query-expired');
    expect(
      classifyTelegramEditRefusal({ description: "Bad Request: can't parse entities" }),
    ).toBe('other');
  });
});
