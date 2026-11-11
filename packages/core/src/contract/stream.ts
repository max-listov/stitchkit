import { z } from 'zod';
import { untilAborted } from '../internal/until-aborted';
import type { EndpointStreamDescriptor } from './define';
import { AppError } from './errors';

/** Default maximum encoded line/frame for a contract stream: 256 KiB. */
export const DEFAULT_CONTRACT_STREAM_FRAME_BYTES = 256 * 1024;

/** The error a contract stream or a process answer carries: the public envelope of one refusal. */
export const ContractStreamErrorSchema = z
  .object({
    code: z.string(),
    message: z.string().optional(),
    details: z.unknown().optional(),
    hint: z.string().optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ContractStreamError = z.infer<typeof ContractStreamErrorSchema>;

export const ContractStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), error: ContractStreamErrorSchema }).strict(),
  z.object({ type: z.literal('end') }).strict(),
]);
export type ContractStreamFrame = z.infer<typeof ContractStreamFrameSchema>;

/** One accepted item of a contract stream, and whether it is the declared terminal. */
export interface ContractStreamItem {
  item: unknown;
  terminal: boolean;
}

function checkContractStreamItem(
  descriptor: EndpointStreamDescriptor,
  value: unknown,
): ContractStreamItem {
  const parsed = descriptor.item.safeParse(value);
  if (!parsed.success) {
    console.error('[stitchkit] contract stream item failed validation:', parsed.error);
    throw new AppError('STREAM_ITEM_INVALID', {
      message: 'Stream item did not match its contract',
      status: 500,
    });
  }
  return {
    item: parsed.data,
    terminal: descriptor.terminal?.safeParse(parsed.data).success ?? false,
  };
}

/**
 * Read a stream source under its contract descriptor — the one loop every
 * surface that carries a contract stream runs, so an item is accepted, a
 * terminal completes and a missing terminal is refused identically over HTTP
 * and in a CLI command.
 *
 * Each value is parsed by `stream.item` (`STREAM_ITEM_INVALID` otherwise); with
 * `completion: 'terminal'` the generator ends at the terminal item; a source
 * that ends before a declared terminal throws `STREAM_TERMINAL_MISSING`. A wait
 * for the source ends as soon as `signal` aborts, whether or not the source
 * honours it. `observe` sees each pending read, for a surface that settles the
 * source's cleanup on its own schedule.
 */
export async function* readContractStreamItems(
  iterator: AsyncIterator<unknown>,
  descriptor: EndpointStreamDescriptor,
  signal: AbortSignal,
  observe?: (pending: Promise<IteratorResult<unknown>>) => void,
): AsyncGenerator<ContractStreamItem> {
  let terminalSeen = descriptor.terminal === undefined;
  for (;;) {
    const pending = Promise.resolve(iterator.next());
    observe?.(pending);
    const next = await untilAborted(pending, signal);
    if (next.done) break;
    const checked = checkContractStreamItem(descriptor, next.value);
    if (checked.terminal) terminalSeen = true;
    yield checked;
    if (checked.terminal && descriptor.completion === 'terminal') return;
  }
  if (!terminalSeen) {
    throw new AppError('STREAM_TERMINAL_MISSING', {
      message: 'Stream completed before its declared terminal item',
      status: 500,
    });
  }
}

/** The refusal of a stream that outlived its declared `lifetimeMs`. */
export function contractStreamLifetimeExceeded(): AppError {
  return new AppError('STREAM_LIFETIME_EXCEEDED', {
    message: 'Stream exceeded its declared lifetime',
    status: 408,
  });
}
