/**
 * The waveform of a recording from its decoded PCM: mono, 16-bit, little-endian
 * (`ffmpeg -i <audio> -ac 1 -ar 8000 -f s16le <file>`).
 *
 * The file is read in chunks, so an hour of audio never sits in memory; the
 * waveform needs the loudness of each part, not the bandwidth, and 8 kHz keeps
 * six hours under 350 MB of PCM. The recording being sent is never this file:
 * the PCM is a side copy, and what is uploaded stays byte for byte what it was.
 */

import { open } from 'node:fs/promises';
import {
  packTelegramVoiceWaveform,
  TELEGRAM_VOICE_WAVEFORM_SAMPLES,
  TelegramVoiceWaveformError,
} from './voice-waveform';

const CHUNK_BYTES = 256 * 1024;
const SAMPLE_BYTES = 2;

export interface ReadTelegramVoiceWaveformOptions {
  /** Stops the read between chunks with the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * The packed waveform `sendVoice` takes, from a PCM file. A file with no
 * sample is refused (`empty-pcm`), and so is one that ends inside a sample or
 * shrinks while it is read (`truncated-pcm`): a waveform is never made up.
 * The refusal names the reason, not the path.
 */
export async function readTelegramVoiceWaveform(
  pcmPath: string,
  options: ReadTelegramVoiceWaveformOptions = {},
): Promise<string> {
  const { signal } = options;
  signal?.throwIfAborted();
  const file = await open(pcmPath, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0) throw new TelegramVoiceWaveformError('empty-pcm');
    if (size % SAMPLE_BYTES !== 0) throw new TelegramVoiceWaveformError('truncated-pcm');
    const samples = size / SAMPLE_BYTES;
    const peaks = new Uint16Array(TELEGRAM_VOICE_WAVEFORM_SAMPLES);
    const buffer = new Uint8Array(Math.min(CHUNK_BYTES, size));
    const view = new DataView(buffer.buffer);
    for (let offset = 0; offset < size; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (bytesRead === 0 || bytesRead % SAMPLE_BYTES !== 0)
        throw new TelegramVoiceWaveformError('truncated-pcm');
      const first = offset / SAMPLE_BYTES;
      for (let index = 0; index < bytesRead; index += SAMPLE_BYTES) {
        const part = Math.floor(
          ((first + index / SAMPLE_BYTES) * TELEGRAM_VOICE_WAVEFORM_SAMPLES) / samples,
        );
        const peak = Math.abs(view.getInt16(index, true));
        if (peak > (peaks[part] ?? 0)) peaks[part] = peak;
      }
      offset += bytesRead;
    }
    return packTelegramVoiceWaveform(peaks);
  } finally {
    await file.close();
  }
}
