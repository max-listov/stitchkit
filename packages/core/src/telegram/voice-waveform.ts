/**
 * The waveform of a Telegram voice message: the bars a client draws under the
 * play button.
 *
 * Telegram stores it as a run of 5-bit levels packed little-endian — a voice
 * note sent by a Telegram client carries 100 of them, 63 bytes. The public Bot
 * API has no field for it, and Telegram then draws its own; a local Bot API
 * server can accept one in `sendVoice`, and such a server says so in `getMe`
 * (`supports_voice_waveform`, `voice_waveform_version`).
 *
 * The levels follow Telegram Desktop: each of the 100 parts of the recording
 * keeps its loudest sample, and the scale is 1.8 times the mean of those
 * peaks, never below a floor — a loud recording does not flatten its quiet
 * parts to nothing, and a quiet one is not stretched into a loud-looking one.
 * Silence stays at zero.
 *
 * Nothing here touches a file or the network, so the server that packs a
 * waveform and the page that draws it read one format.
 */

/** Parts of the recording a waveform describes. */
export const TELEGRAM_VOICE_WAVEFORM_SAMPLES = 100;
/** The highest level of a bar: levels are 5 bits, `0`–`31`. */
export const TELEGRAM_VOICE_WAVEFORM_MAX_LEVEL = 31;
/** The version of the `sendVoice` waveform field a Bot API server declares in `getMe`. */
export const TELEGRAM_VOICE_WAVEFORM_VERSION = 1;

const BITS_PER_LEVEL = 5;
const PACKED_BYTES = Math.ceil((TELEGRAM_VOICE_WAVEFORM_SAMPLES * BITS_PER_LEVEL) / 8);
/** Telegram Desktop's scale: the mean peak times 1.8 … */
const MEAN_PEAK_SCALE = 1.8;
/** … and never below this peak of 16-bit PCM, so a quiet recording stays low. */
const PEAK_FLOOR = 2500;
/** The loudest 16-bit sample, `-32768`, taken without its sign. */
const PEAK_MAX = 32768;

/**
 * Why a waveform was not made or not read.
 *
 * - `peak-count` — `packTelegramVoiceWaveform` takes exactly 100 peaks.
 * - `peak-value` — a peak is not an integer from `0` to `32768`.
 * - `malformed` — the waveform text is not base64.
 * - `empty-pcm` — the PCM has no sample: there is nothing to draw.
 * - `truncated-pcm` — the PCM ends inside a sample, or ended before its size.
 */
export type TelegramVoiceWaveformRefusal =
  | 'peak-count'
  | 'peak-value'
  | 'malformed'
  | 'empty-pcm'
  | 'truncated-pcm';

export class TelegramVoiceWaveformError extends Error {
  readonly reason: TelegramVoiceWaveformRefusal;

  constructor(reason: TelegramVoiceWaveformRefusal) {
    super(`Telegram voice waveform refused: ${reason}`);
    this.name = 'TelegramVoiceWaveformError';
    this.reason = reason;
  }
}

/**
 * The waveform `sendVoice` takes, from the loudest absolute sample of each of
 * the 100 equal parts of a recording (16-bit PCM: `0`–`32768`): base64 of 63
 * bytes. `readTelegramVoiceWaveform` from `stitchkit/telegram` finds the
 * peaks in a PCM file and calls this.
 */
export function packTelegramVoiceWaveform(peaks: ArrayLike<number>): string {
  if (peaks.length !== TELEGRAM_VOICE_WAVEFORM_SAMPLES)
    throw new TelegramVoiceWaveformError('peak-count');
  const values = Array.from(peaks);
  let sum = 0;
  for (const peak of values) {
    if (!Number.isInteger(peak) || peak < 0 || peak > PEAK_MAX)
      throw new TelegramVoiceWaveformError('peak-value');
    sum += peak;
  }
  const ceiling = Math.max(
    Math.floor((sum * MEAN_PEAK_SCALE) / TELEGRAM_VOICE_WAVEFORM_SAMPLES),
    PEAK_FLOOR,
  );
  const packed = new Uint8Array(PACKED_BYTES);
  for (const [index, peak] of values.entries()) {
    const level = Math.floor(
      (Math.min(peak, ceiling) * TELEGRAM_VOICE_WAVEFORM_MAX_LEVEL) / ceiling,
    );
    const bit = index * BITS_PER_LEVEL;
    const byte = bit >> 3;
    const shift = bit & 7;
    packed[byte] = (packed[byte] ?? 0) | ((level << shift) & 0xff);
    if (shift > 8 - BITS_PER_LEVEL) packed[byte + 1] = level >> (8 - shift);
  }
  return btoa(String.fromCharCode(...packed));
}

/**
 * The levels of a waveform, each `0`–`31`, for drawing it: one per 5 bits, so
 * the 63 bytes `packTelegramVoiceWaveform` makes give 100, and a waveform
 * Telegram drew itself gives however many it holds. Text that is not base64
 * is refused, never read as silence.
 */
export function unpackTelegramVoiceWaveform(waveform: string): number[] {
  let text: string;
  try {
    text = atob(waveform);
  } catch {
    throw new TelegramVoiceWaveformError('malformed');
  }
  const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
  const count = Math.floor((bytes.length * 8) / BITS_PER_LEVEL);
  return Array.from({ length: count }, (_, index) => {
    const bit = index * BITS_PER_LEVEL;
    const byte = bit >> 3;
    const pair = (bytes[byte] ?? 0) | ((bytes[byte + 1] ?? 0) << 8);
    return (pair >> (bit & 7)) & TELEGRAM_VOICE_WAVEFORM_MAX_LEVEL;
  });
}

/** What a Bot API server said in `getMe` about the `sendVoice` waveform field. */
export interface TelegramVoiceWaveformSupport {
  /** The server takes the waveform this module packs: it declares version 1. */
  readonly supported: boolean;
  /** The version it declares; `null` when it declares none (the public Bot API). */
  readonly version: number | null;
}

/**
 * Whether the server behind a `getMe` answer takes the waveform: the `result`
 * of `getMe` as it came, any shape. A server that declares nothing, or another
 * version, does not — and a voice sent there gets whatever Telegram draws.
 */
export function readTelegramVoiceWaveformSupport(me: unknown): TelegramVoiceWaveformSupport {
  const declared = typeof me === 'object' && me !== null;
  const flag = declared ? Reflect.get(me, 'supports_voice_waveform') : undefined;
  const raw = declared ? Reflect.get(me, 'voice_waveform_version') : undefined;
  const version = typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
  return {
    supported: flag === true && version === TELEGRAM_VOICE_WAVEFORM_VERSION,
    version,
  };
}
