import { describe, expect, test } from 'bun:test';
import {
  LIVE_VOICE_PHASES,
  type LiveVoicePhase,
  SentenceCutter,
  SpeechQueue,
  speakableText,
} from '../src/entrypoints/voice';

/*
 * The mechanics of a live voice reply: the text is cut into sentences while it streams, each
 * sentence is stripped to what can be said, and a queue speaks them in order with the next one
 * synthesised while the current one plays.
 */

/** Feed `text` to a cutter in chunks of `size`, as a streaming model would. */
function stream(text: string, size: number): string[] {
  const cutter = new SentenceCutter();
  const sentences: string[] = [];
  for (let end = size; end < text.length; end += size) {
    sentences.push(...cutter.next(text.slice(0, end), false));
  }
  sentences.push(...cutter.next(text, true));
  return sentences;
}

describe('SentenceCutter', () => {
  test('cuts at a sentence end followed by a capital, and only once', () => {
    const cutter = new SentenceCutter();
    expect(cutter.next('Привет. Как дела', false)).toEqual(['Привет.']);
    expect(cutter.next('Привет. Как дела? Хорошо', false)).toEqual(['Как дела?']);
    expect(cutter.next('Привет. Как дела? Хорошо', true)).toEqual(['Хорошо']);
  });

  test('the end of the text is not yet the end of a sentence until the turn is final', () => {
    const cutter = new SentenceCutter();
    expect(cutter.next('Готово.', false)).toEqual([]);
    expect(cutter.next('Готово. ', false)).toEqual([]);
    expect(cutter.next('Готово.', true)).toEqual(['Готово.']);
  });

  test('does not cut numbers, abbreviations or an ellipsis before lowercase', () => {
    expect(stream('Версия 3.5 вышла. Т. е. так и есть… и дальше. Всё', 3)).toEqual([
      'Версия 3.5 вышла.',
      'Т. е. так и есть… и дальше.',
      'Всё',
    ]);
    expect(stream('Это т. е. пример, г. в Москве. Конец', 4)).toEqual([
      'Это т. е. пример, г. в Москве.',
      'Конец',
    ]);
  });

  test('an ellipsis before a capital ends a sentence, and so do closing quotes', () => {
    expect(stream('Ну... Ладно. Он сказал «Иди.» Потом ушёл', 2)).toEqual([
      'Ну...',
      'Ладно.',
      'Он сказал «Иди.»',
      'Потом ушёл',
    ]);
  });

  test('a paragraph break is a boundary without punctuation', () => {
    expect(stream('Первый абзац\n\nВторой абзац', 5)).toEqual([
      'Первый абзац',
      'Второй абзац',
    ]);
  });

  test('never cuts inside a fenced code block, closed or still streaming', () => {
    const text = 'Смотри:\n\n```ts\nconst a = 1. B = 2;\n\nfoo()\n```\nГотово. Дальше';
    expect(stream(text, 4)).toEqual([
      'Смотри:',
      '```ts\nconst a = 1. B = 2;\n\nfoo()\n```\nГотово.',
      'Дальше',
    ]);
    const cutter = new SentenceCutter();
    expect(cutter.next('Код:\n\n```\nx. Y\n\nz', false)).toEqual(['Код:']);
  });

  test('streaming in any chunk size gives the same sentences as the whole text', () => {
    const text = 'Раз. Два! Три? «Четыре». (Пять.) 6 — шесть.\n\nСемь';
    const whole = stream(text, text.length);
    for (const size of [1, 2, 3, 7, 11]) expect(stream(text, size)).toEqual(whole);
    expect(whole).toEqual([
      'Раз.',
      'Два!',
      'Три?',
      '«Четыре».',
      '(Пять.)',
      '6 — шесть.',
      'Семь',
    ]);
  });

  test('reset starts a new turn', () => {
    const cutter = new SentenceCutter();
    expect(cutter.next('Один. Два', true)).toEqual(['Один.', 'Два']);
    cutter.reset();
    expect(cutter.next('Три. Четыре', false)).toEqual(['Три.']);
  });
});

describe('speakableText', () => {
  test('keeps visible text and drops Markdown delimiters, links and images', () => {
    expect(
      speakableText(
        '## Итог\n\n**Готово**: смотри [отчёт](https://x.test/a) и ![график](g.png).\n- пункт *один*\n> цитата `код`',
      ),
    ).toBe('Итог Готово: смотри отчёт и. пункт один цитата код');
  });

  test('drops fenced code blocks and tables whole', () => {
    const text = [
      'До.',
      '```ts',
      'const secret = 1;',
      '```',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      'После.',
      '~~~',
      'unclosed',
    ].join('\n');
    expect(speakableText(text)).toBe('До. После.');
  });

  test('drops bare and angle-bracket addresses and keeps snake_case intact', () => {
    expect(
      speakableText(
        'Ссылка https://example.test/path?q=1 и <https://x.test> файл snake_case_name',
      ),
    ).toBe('Ссылка и файл snake_case_name');
  });

  test('a sentence that is only code has nothing to say', () => {
    expect(speakableText('```\nrm -rf /\n```')).toBe('');
  });
});

describe('LIVE_VOICE_PHASES', () => {
  test('is the one vocabulary of phases', () => {
    const phase: LiveVoicePhase = 'speaking';
    expect(LIVE_VOICE_PHASES).toEqual(['opening', 'idle', 'hearing', 'thinking', 'speaking']);
    expect(LIVE_VOICE_PHASES).toContain(phase);
  });
});

/** A promise and its resolver, for steps a test finishes by hand. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A synthesiser and player whose every step the test resolves itself. */
function harness(lookahead?: number) {
  const log: string[] = [];
  const syntheses = new Map<string, Deferred<string>>();
  const plays = new Map<string, Deferred<void>>();
  const signals = new Map<string, AbortSignal>();
  const errors: string[] = [];
  const discarded: string[] = [];
  const queue = new SpeechQueue<string>({
    prepare(text, signal) {
      log.push(`prepare ${text}`);
      signals.set(`prepare ${text}`, signal);
      const step = deferred<string>();
      syntheses.set(text, step);
      return step.promise;
    },
    play(clip, signal) {
      log.push(`play ${clip}`);
      signals.set(`play ${clip}`, signal);
      const step = deferred<void>();
      plays.set(clip, step);
      return step.promise;
    },
    ...(lookahead !== undefined && { lookahead }),
    onError: (error, text) => void errors.push(`${text}: ${String(error)}`),
    discard: (clip) => void discarded.push(clip),
  });
  return { queue, log, syntheses, plays, signals, errors, discarded };
}

describe('SpeechQueue', () => {
  test('prepares the second sentence while the first one plays', async () => {
    const { queue, log, syntheses, plays } = harness();
    queue.push('one');
    queue.push('two');
    await tick();
    syntheses.get('one')?.resolve('clip-one');
    await tick();
    expect(queue.isSpeaking).toBe(true);
    expect(log).toEqual(['prepare one', 'prepare two', 'play clip-one']);
    syntheses.get('two')?.resolve('clip-two');
    plays.get('clip-one')?.resolve();
    await tick();
    expect(log.at(-1)).toBe('play clip-two');
    queue.close();
    plays.get('clip-two')?.resolve();
    await queue.done;
    expect(queue.isSpeaking).toBe(false);
  });

  test('holds at most lookahead sentences beyond the one playing', async () => {
    const { queue, log, syntheses, plays } = harness(1);
    for (const text of ['a', 'b', 'c', 'd']) queue.push(text);
    await tick();
    syntheses.get('a')?.resolve('A');
    await tick();
    expect(log).toEqual(['prepare a', 'prepare b', 'play A']);
    syntheses.get('b')?.resolve('B');
    plays.get('A')?.resolve();
    await tick();
    expect(log).toEqual(['prepare a', 'prepare b', 'play A', 'prepare c', 'play B']);
  });

  test('lookahead 0 prepares a sentence only after the previous one played', async () => {
    const { queue, log, syntheses, plays } = harness(0);
    queue.push('a');
    queue.push('b');
    await tick();
    syntheses.get('a')?.resolve('A');
    await tick();
    expect(log).toEqual(['prepare a', 'play A']);
    plays.get('A')?.resolve();
    await tick();
    expect(log).toEqual(['prepare a', 'play A', 'prepare b']);
  });

  test('cancel in the middle of playing aborts it and every synthesis and plays nothing more', async () => {
    const { queue, log, syntheses, signals, discarded } = harness();
    queue.push('one');
    queue.push('two');
    queue.push('three');
    await tick();
    syntheses.get('one')?.resolve('clip-one');
    await tick();
    queue.cancel();
    expect(queue.isCancelled).toBe(true);
    expect(signals.get('play clip-one')?.aborted).toBe(true);
    expect(signals.get('prepare two')?.aborted).toBe(true);
    await queue.done;
    syntheses.get('two')?.resolve('clip-two');
    await tick();
    queue.push('four');
    await tick();
    expect(log).toEqual(['prepare one', 'prepare two', 'play clip-one']);
    expect(discarded).toEqual(['clip-two']);
  });

  test('done settles on cancel even when play ignores its signal', async () => {
    const { queue, syntheses } = harness();
    queue.push('one');
    await tick();
    syntheses.get('one')?.resolve('clip-one');
    await tick();
    queue.cancel();
    await queue.done;
    expect(queue.isSpeaking).toBe(false);
  });

  test('a sentence that fails to prepare or play is skipped and reported', async () => {
    const { queue, log, syntheses, plays, errors } = harness();
    queue.push('bad');
    queue.push('worse');
    queue.push('good');
    queue.close();
    await tick();
    syntheses.get('bad')?.reject(new Error('503'));
    await tick();
    syntheses.get('worse')?.resolve('clip-worse');
    await tick();
    plays.get('clip-worse')?.reject(new Error('device lost'));
    await tick();
    syntheses.get('good')?.resolve('clip-good');
    await tick();
    plays.get('clip-good')?.resolve();
    await queue.done;
    expect(errors).toEqual(['bad: Error: 503', 'worse: Error: device lost']);
    expect(log.filter((line) => line.startsWith('play'))).toEqual([
      'play clip-worse',
      'play clip-good',
    ]);
  });

  test('close finishes what is queued; blank text and pushes after close are ignored', async () => {
    const { queue, log, syntheses, plays } = harness();
    queue.push('   ');
    queue.push('last');
    queue.close();
    queue.push('late');
    await tick();
    syntheses.get('last')?.resolve('clip-last');
    await tick();
    plays.get('clip-last')?.resolve();
    await queue.done;
    expect(log).toEqual(['prepare last', 'play clip-last']);
  });

  test('an empty closed queue is done at once, and lookahead must be a non-negative integer', async () => {
    const queue = new SpeechQueue<string>({
      prepare: async (text) => text,
      play: async () => undefined,
    });
    queue.close();
    await queue.done;
    expect(
      () =>
        new SpeechQueue({
          prepare: async () => 1,
          play: async () => undefined,
          lookahead: -1,
        }),
    ).toThrow(RangeError);
  });
});
