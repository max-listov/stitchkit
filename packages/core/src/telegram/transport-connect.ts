import { lookup } from 'node:dns/promises';
import { connect as connectTcp, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { TelegramNotDispatchedError } from './not-dispatched';

/**
 * The part of a Node `net.Socket` / `tls.TLSSocket` the transport uses, so its declarations need
 * no Node types. A socket emits `connect` (or `secureConnect` when `encrypted`), `data`, `end`,
 * `close` and `error`.
 */
export interface TelegramBotTransportSocket {
  readonly encrypted?: boolean;
  once(event: 'connect' | 'secureConnect' | 'end' | 'close', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  write(data: Uint8Array): unknown;
  destroy(): unknown;
}

/** Opens one socket to one address; `servername` is set for TLS to a host name. */
export type TelegramBotTransportOpen = (target: {
  readonly address: string;
  readonly port: number;
  readonly tls: boolean;
  readonly servername: string | undefined;
}) => TelegramBotTransportSocket;

/** Every address of a host, in the system resolver's order. */
export type TelegramBotTransportResolve = (host: string) => Promise<readonly string[]>;

export interface TelegramConnectPolicy {
  readonly resolve: TelegramBotTransportResolve;
  readonly open: TelegramBotTransportOpen;
  /** Real milliseconds one round waits for a connection. */
  readonly attemptMs: number;
  /** Real milliseconds after which no new connection round starts. */
  readonly budgetMs: number;
}

/** Delay before the next address of a round starts (RFC 8305, Happy Eyeballs). */
const NEXT_ADDRESS_DELAY_MS = 250;
/** An address that refuses at once must not spin the whole budget in rounds. */
const MAX_ROUNDS = 3;

export const resolveAll: TelegramBotTransportResolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export const openSocket: TelegramBotTransportOpen = ({ address, port, tls, servername }) =>
  tls
    ? connectTls({
        host: address,
        port,
        ...(servername !== undefined && { servername }),
        ALPNProtocols: ['http/1.1'],
      })
    : connectTcp({ host: address, port });

const connectedEvent = (socket: TelegramBotTransportSocket) =>
  'encrypted' in socket && socket.encrypted ? 'secureConnect' : 'connect';

/** One round: addresses start as a staircase and the first connected socket wins. */
function race(
  addresses: readonly string[],
  target: { port: number; tls: boolean; servername: string | undefined },
  open: TelegramBotTransportOpen,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ socket: TelegramBotTransportSocket } | { failure: unknown }> {
  return new Promise((resolve) => {
    const sockets: TelegramBotTransportSocket[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let failed = 0;
    let started = 0;
    let lastFailure: unknown;
    let settled = false;
    const finish = (winner: TelegramBotTransportSocket | undefined) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      for (const socket of sockets) if (socket !== winner) socket.destroy();
      resolve(winner ? { socket: winner } : { failure: lastFailure });
    };
    const abort = () => finish(undefined);
    const failOne = (cause: unknown) => {
      lastFailure = cause;
      if (++failed === addresses.length) finish(undefined);
      else launchNext();
    };
    const launchNext = () => {
      if (settled) return;
      const address = addresses[started++];
      if (address === undefined) return;
      let socket: TelegramBotTransportSocket;
      try {
        socket = open({ address, ...target });
      } catch (cause) {
        failOne(cause);
        return;
      }
      sockets.push(socket);
      socket.once(connectedEvent(socket), () => finish(socket));
      socket.once('error', (cause) => {
        socket.destroy();
        failOne(cause);
      });
      if (started < addresses.length)
        timers.push(setTimeout(launchNext, NEXT_ADDRESS_DELAY_MS));
    };
    timers.push(setTimeout(() => finish(undefined), timeoutMs));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) finish(undefined);
    else launchNext();
  });
}

/**
 * The addresses of `host`. A resolver that cannot be cancelled still ends the wait when the caller
 * aborts, and no lookup waits longer than the connection budget.
 */
function lookupWithin(
  host: string,
  policy: TelegramConnectPolicy,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const settle = (act: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      act();
    };
    const abort = () => settle(() => reject(signal?.reason));
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error(`Address lookup took longer than ${policy.budgetMs} ms`)),
        ),
      policy.budgetMs,
    );
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => policy.resolve(host))
      .then(
        (found) => settle(() => resolve(found)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

/**
 * A connected socket to `host`, or `TelegramNotDispatchedError`: nothing has been written yet,
 * so every failure here leaves the request unsent. An abort rejects with the signal's reason.
 */
export async function establish(
  host: string,
  port: number,
  tls: boolean,
  policy: TelegramConnectPolicy,
  signal: AbortSignal | undefined,
): Promise<TelegramBotTransportSocket> {
  const literal = isIP(host) !== 0;
  let addresses: readonly string[];
  if (literal) addresses = [host];
  else {
    try {
      addresses = await lookupWithin(host, policy, signal);
    } catch (cause) {
      signal?.throwIfAborted();
      throw new TelegramNotDispatchedError('lookup', 'Telegram address lookup failed', {
        cause,
      });
    }
  }
  signal?.throwIfAborted();
  if (addresses.length === 0)
    throw new TelegramNotDispatchedError('lookup', 'Telegram address lookup returned nothing');
  const target = { port, tls, servername: tls && !literal ? host : undefined };
  const deadline = performance.now() + policy.budgetMs;
  let lastFailure: unknown;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const left = deadline - performance.now();
    if (left <= 0) break;
    const outcome = await race(
      addresses,
      target,
      policy.open,
      Math.min(policy.attemptMs, left),
      signal,
    );
    // A socket that connected as the caller aborted is not handed on: nobody would close it.
    if (signal?.aborted && 'socket' in outcome) outcome.socket.destroy();
    signal?.throwIfAborted();
    if ('socket' in outcome) return outcome.socket;
    lastFailure = outcome.failure ?? lastFailure;
  }
  throw new TelegramNotDispatchedError('connect', 'Telegram connection was not established', {
    cause: lastFailure,
  });
}
