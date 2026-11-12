import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packTelegramVoiceWaveform,
  readTelegramVoiceWaveformSupport,
  TELEGRAM_VOICE_WAVEFORM_MAX_LEVEL,
  TELEGRAM_VOICE_WAVEFORM_SAMPLES,
  TelegramVoiceWaveformError,
  type TelegramVoiceWaveformRefusal,
  unpackTelegramVoiceWaveform,
} from '../src/telegram/voice-waveform';
import { readTelegramVoiceWaveform } from '../src/telegram/voice-waveform-pcm';

/*
 * A voice message's bars: 100 levels of 5 bits, packed little-endian, scaled
 * the way Telegram Desktop scales them. The packing is checked against a
 * bit-by-bit writer of its own, so a shared mistake in shifting cannot pass
 * both sides.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function pcmFile(samples: ArrayLike<number> | Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stitchkit-waveform-'));
  directories.push(directory);
  const path = join(directory, 'wave.pcm');
  if (Buffer.isBuffer(samples)) {
    await writeFile(path, samples);
    return path;
  }
  const bytes = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++)
    bytes.writeInt16LE(samples[index] ?? 0, index * 2);
  await writeFile(path, bytes);
  return path;
}

/** One bit at a time: the slow, obvious writer the packed bytes must equal. */
function packBitByBit(levels: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil((levels.length * 5) / 8));
  for (const [index, level] of levels.entries())
    for (let bit = 0; bit < 5; bit++)
      if (level & (1 << bit)) {
        const at = index * 5 + bit;
        bytes[at >> 3] = (bytes[at >> 3] ?? 0) | (1 << (at & 7));
      }
  return bytes;
}

function bytesOf(waveform: string): Uint8Array {
  return Uint8Array.from(atob(waveform), (char) => char.charCodeAt(0));
}

function refusalOf(run: () => unknown): TelegramVoiceWaveformRefusal | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof TelegramVoiceWaveformError) return error.reason;
    throw error;
  }
  return undefined;
}

const peaks = (fill: (index: number) => number) =>
  Array.from({ length: TELEGRAM_VOICE_WAVEFORM_SAMPLES }, (_, index) => fill(index));

describe('packing a waveform', () => {
  test('100 peaks become 63 bytes laid out exactly as a bit-by-bit writer lays them', () => {
    // A ramp repeated: every level from 0 to 31 occurs, at every bit offset a byte allows.
    const source = peaks((index) => (index % 32) * 1000);
    const sum = source.reduce((total, peak) => total + peak, 0);
    const ceiling = Math.max(Math.floor((sum * 1.8) / 100), 2500);
    const expected = source.map((peak) =>
      Math.floor((Math.min(peak, ceiling) * 31) / ceiling),
    );
    expect(new Set(expected).size).toBeGreaterThan(20);
    const packed = packTelegramVoiceWaveform(source);
    expect(packed).toHaveLength(84);
    expect(bytesOf(packed)).toEqual(packBitByBit(expected));
    expect(unpackTelegramVoiceWaveform(packed)).toEqual(expected);
    // 100 levels fill 500 of 504 bits: the last four stay clear.
    expect((bytesOf(packed)[62] ?? 0) & 0xf0).toBe(0);
  });

  test('levels follow 1.8 × the mean peak, so a loud quarter reaches the top and silence stays zero', () => {
    const levels = unpackTelegramVoiceWaveform(
      packTelegramVoiceWaveform(peaks((index) => (index < 25 ? 30_000 : 0))),
    );
    expect(levels).toEqual(
      peaks((index) => (index < 25 ? TELEGRAM_VOICE_WAVEFORM_MAX_LEVEL : 0)),
    );
    expect(packTelegramVoiceWaveform(peaks(() => 0))).toBe(btoa('\0'.repeat(63)));
  });

  test('a quiet recording stays low: the scale never drops below the floor', () => {
    // Every peak 1000: the mean rule alone (1800) would draw it near the top; the floor keeps it at 12.
    expect(unpackTelegramVoiceWaveform(packTelegramVoiceWaveform(peaks(() => 1000)))).toEqual(
      peaks(() => 12),
    );
    // Above the floor the mean rule decides: one part at 30 000 among 5000s scales by 9450,
    // so the 5000s draw at 16 — where scaling by the loudest part would draw them at 5.
    const levels = unpackTelegramVoiceWaveform(
      packTelegramVoiceWaveform(peaks((index) => (index === 0 ? 30_000 : 5000))),
    );
    expect(levels[0]).toBe(31);
    expect(levels[1]).toBe(16);
  });

  test('a peak count other than 100 and a peak outside 16-bit PCM are refused', () => {
    expect(refusalOf(() => packTelegramVoiceWaveform(new Array(99).fill(0)))).toBe(
      'peak-count',
    );
    expect(refusalOf(() => packTelegramVoiceWaveform([]))).toBe('peak-count');
    for (const bad of [-1, 1.5, 32_769, Number.NaN])
      expect(
        refusalOf(() => packTelegramVoiceWaveform(peaks((i) => (i === 7 ? bad : 0)))),
      ).toBe('peak-value');
    expect(refusalOf(() => packTelegramVoiceWaveform(peaks(() => 32_768)))).toBeUndefined();
  });
});

describe('reading a waveform', () => {
  test('a waveform Telegram drew itself gives as many levels as its bits hold', () => {
    const levels = Array.from({ length: 99 }, (_, index) => (index * 7) % 32);
    const drawn = btoa(String.fromCharCode(...packBitByBit(levels)));
    expect(bytesOf(drawn)).toHaveLength(62);
    expect(unpackTelegramVoiceWaveform(drawn)).toEqual(levels);
  });

  test('text that is not base64 is refused, not read as silence', () => {
    expect(refusalOf(() => unpackTelegramVoiceWaveform('not base64!'))).toBe('malformed');
  });
});

describe('whether a server takes the waveform', () => {
  test('only a declared version 1 is support', () => {
    expect(
      readTelegramVoiceWaveformSupport({
        id: 1,
        is_bot: true,
        supports_voice_waveform: true,
        voice_waveform_version: 1,
      }),
    ).toEqual({ supported: true, version: 1 });
    expect(
      readTelegramVoiceWaveformSupport({
        supports_voice_waveform: true,
        voice_waveform_version: 2,
      }),
    ).toEqual({ supported: false, version: 2 });
    expect(
      readTelegramVoiceWaveformSupport({
        supports_voice_waveform: false,
        voice_waveform_version: 1,
      }),
    ).toEqual({ supported: false, version: 1 });
    // The public Bot API declares nothing.
    expect(readTelegramVoiceWaveformSupport({ id: 1, is_bot: true })).toEqual({
      supported: false,
      version: null,
    });
  });

  test('an answer of another shape is no support, never an exception', () => {
    for (const answer of [null, undefined, 'ok', 42])
      expect(readTelegramVoiceWaveformSupport(answer)).toEqual({
        supported: false,
        version: null,
      });
    expect(
      readTelegramVoiceWaveformSupport({
        supports_voice_waveform: 'true',
        voice_waveform_version: '1',
      }),
    ).toEqual({ supported: false, version: null });
  });
});

describe('the waveform of a PCM file', () => {
  test('covers the whole file across chunk boundaries, the sign of a sample aside', async () => {
    // 300 000 samples, 600 000 bytes: three chunks. The loud first quarter ends inside the first;
    // the softer last quarter lies in the third, and only its place in the file puts it at the end.
    const samples = Array.from({ length: 300_000 }, (_, index) =>
      index < 75_000 ? (index % 2 ? -30_000 : 29_000) : index >= 225_000 ? -20_000 : 0,
    );
    const waveform = await readTelegramVoiceWaveform(await pcmFile(samples));
    expect(waveform).toBe(
      packTelegramVoiceWaveform(
        peaks((index) => (index < 25 ? 30_000 : index >= 75 ? 20_000 : 0)),
      ),
    );
  });

  test('every part keeps its own loudest sample, the last part included', async () => {
    // 1000 samples: part n is samples 10n…10n+9, and its peak is placed at the part's last sample.
    const samples = new Array<number>(1000).fill(0);
    for (let part = 0; part < 100; part++) samples[part * 10 + 9] = (part + 1) * 300;
    samples[999] = -32_768;
    const waveform = await readTelegramVoiceWaveform(await pcmFile(samples));
    expect(waveform).toBe(
      packTelegramVoiceWaveform(peaks((part) => (part === 99 ? 32_768 : (part + 1) * 300))),
    );
  });

  test('a recording shorter than 100 samples fills only the parts it reaches', async () => {
    const waveform = await readTelegramVoiceWaveform(await pcmFile([20_000, 20_000]));
    expect(waveform).toBe(
      packTelegramVoiceWaveform(peaks((part) => (part % 50 === 0 ? 20_000 : 0))),
    );
  });

  test('an empty or cut file is refused without naming its path', async () => {
    const empty = await pcmFile(Buffer.alloc(0));
    const cut = await pcmFile(Buffer.alloc(3));
    for (const [path, reason] of [
      [empty, 'empty-pcm'],
      [cut, 'truncated-pcm'],
    ] as const) {
      const error = await readTelegramVoiceWaveform(path).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TelegramVoiceWaveformError);
      expect(error).toMatchObject({ reason });
      expect(String(error)).not.toContain(path);
    }
  });

  test('a signal stops the read with its own reason, before the file and between chunks', async () => {
    const reason = new Error('the job was cancelled');
    const before = new AbortController();
    before.abort(reason);
    const short = await pcmFile(new Array(10).fill(1000));
    expect(
      await readTelegramVoiceWaveform(short, { signal: before.signal }).catch((e) => e),
    ).toBe(reason);
    // Cancelled while the first of three chunks is being read: the second is never read.
    const during = new AbortController();
    const check = during.signal.throwIfAborted.bind(during.signal);
    let checks = 0;
    Reflect.set(during.signal, 'throwIfAborted', () => {
      checks += 1;
      if (checks === 2) during.abort(reason);
      check();
    });
    const long = await pcmFile(Buffer.alloc(600_000));
    expect(
      await readTelegramVoiceWaveform(long, { signal: during.signal }).catch((e) => e),
    ).toBe(reason);
    expect(checks).toBe(2);
  });
});
