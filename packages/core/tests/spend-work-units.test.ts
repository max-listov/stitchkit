/**
 * Work that is not tokens goes through the same gateway: a speech-to-text upload accounted in
 * seconds of audio.
 *
 * Nothing in `stitchkit/spend` knows what a transcription is. The unit is a free label on the
 * receipt (`workUnit`, `workAmount`), filled by the provider's own `SpendFactsReader` from what its
 * response reports, and the attempt is written before the upload leaves, exactly as for a model
 * call. The provider and its response shape below are the application's, not a vendor's.
 */
import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createSpendGateway,
  runWithSpendAttribution,
  type SpendFactsReader,
} from '../src/entrypoints/spend';
import { memorySpendLedger } from './support/spend-ledger';

const ORIGIN = 'https://speech.example';

/** The application's reader: its provider reports the audio it transcribed as `usage.seconds`. */
const secondsOfAudio: SpendFactsReader = {
  event(value) {
    const parsed = z
      .object({ id: z.string(), usage: z.object({ seconds: z.number().nonnegative() }) })
      .safeParse(value);
    if (!parsed.success) return {};
    return {
      providerRequestId: parsed.data.id,
      workUnit: 'audio-second',
      workAmount: parsed.data.usage.seconds,
    };
  },
};

test('a transcription is recorded before the upload and closed with the seconds of audio it used', async () => {
  const ledger = memorySpendLedger();
  const sent: { beganFirst: boolean; type: string | null; bytes: number }[] = [];
  const gateway = createSpendGateway({
    store: ledger.store,
    providers: [
      {
        name: 'speech',
        origin: ORIGIN,
        headers: () => ({ authorization: 'Bearer speech-key' }),
        facts: secondsOfAudio,
      },
    ],
    newAttemptId: () => 'attempt-1',
    fetch: async (request) => {
      sent.push({
        beganFirst: ledger.order.includes('begin:attempt-1'),
        type: request.headers.get('content-type'),
        bytes: (await request.arrayBuffer()).byteLength,
      });
      return Response.json({ id: 'tr-1', text: '…', usage: { seconds: 12.5 } });
    },
  });
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(4096)], { type: 'audio/ogg' }), 'note.ogg');

  const response = await runWithSpendAttribution(
    { purpose: 'transcription', scope: 'account-1' },
    () =>
      gateway.fetchFor('speech')(`${ORIGIN}/v1/transcriptions`, {
        method: 'POST',
        body: form,
      }),
  );
  expect(await response.json()).toMatchObject({ id: 'tr-1' });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.beganFirst).toBe(true);
  expect(sent[0]?.type).toStartWith('multipart/form-data; boundary=');
  expect(sent[0]?.bytes).toBeGreaterThan(4096);
  expect(ledger.attempts.get('attempt-1')).toMatchObject({
    gateway: 'speech',
    attribution: { purpose: 'transcription', scope: 'account-1' },
    request: { method: 'POST', origin: ORIGIN, path: '/v1/transcriptions' },
  });
  expect(await ledger.settled('attempt-1')).toMatchObject({
    outcome: 'succeeded',
    facts: {
      providerRequestId: 'tr-1',
      workUnit: 'audio-second',
      workAmount: 12.5,
      // No reported price: the cost waits for a reconciler instead of becoming a guessed zero.
      costStatus: 'pending',
    },
  });
  expect(ledger.order).toEqual(['begin:attempt-1', 'settle:attempt-1']);
});

test('control: a refused admission records the transcription and never uploads it', async () => {
  const ledger = memorySpendLedger();
  let uploads = 0;
  const gateway = createSpendGateway({
    store: ledger.store,
    providers: [
      { name: 'speech', origin: ORIGIN, headers: () => ({}), facts: secondsOfAudio },
    ],
    newAttemptId: () => 'attempt-2',
    admit: () => {
      throw new Error('transcription budget spent');
    },
    fetch: async () => {
      uploads += 1;
      return Response.json({});
    },
  });
  await expect(
    runWithSpendAttribution({ purpose: 'transcription' }, () =>
      gateway.fetchFor('speech')(`${ORIGIN}/v1/transcriptions`, { method: 'POST', body: 'x' }),
    ),
  ).rejects.toMatchObject({ code: 'refused' });
  expect(uploads).toBe(0);
  expect(await ledger.settled('attempt-2')).toMatchObject({ outcome: 'refused' });
});
