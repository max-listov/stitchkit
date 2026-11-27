import { z } from 'zod';
import { type ContractDef, defineContract, type EndpointDef } from '../contract/define';
import {
  defineRealtimeContract,
  type RealtimeContract,
  type RealtimeEventRegistry,
} from '../realtime/contract';
import {
  InteractionReplySchema,
  ThreadClaimSchema,
  ThreadLeaseSchema,
  ThreadReleaseSchema,
  ThreadRenewSchema,
  TurnInterruptSchema,
  TurnOfferSchema,
  TurnReportAckSchema,
  TurnReportSchema,
} from './executor-contract';
import { ExecutorHelloAckSchema, ExecutorHelloSchema } from './hello';

/** The operations of the executor contract, typed once so its declaration names them. */
const agentExecutorEndpoints = {
  hello: {
    method: 'POST',
    path: '/hello',
    expose: ['HTTP'],
    effect: 'write',
    desc: 'Announce an executor process, its engines and profiles; learn how far each resumable turn is held',
    input: ExecutorHelloSchema,
    output: ExecutorHelloAckSchema,
  },
  claim: {
    method: 'POST',
    path: '/threads/claim',
    expose: ['HTTP'],
    effect: 'write',
    desc: 'Lease a thread to this executor and profile, under a new fence',
    input: ThreadClaimSchema,
    output: ThreadLeaseSchema,
  },
  renew: {
    method: 'POST',
    path: '/threads/renew',
    expose: ['HTTP'],
    effect: 'write',
    desc: 'Extend a held thread lease',
    input: ThreadRenewSchema,
    output: ThreadLeaseSchema,
  },
  release: {
    method: 'POST',
    path: '/threads/release',
    expose: ['HTTP'],
    effect: 'write',
    desc: 'Give a thread lease back',
    input: ThreadReleaseSchema,
    output: z.strictObject({ released: z.boolean() }),
  },
  report: {
    method: 'POST',
    path: '/turns/report',
    expose: ['HTTP'],
    effect: 'write',
    desc: 'Report a turn phase and its deltas; resent reports are applied once',
    input: TurnReportSchema,
    output: TurnReportAckSchema,
  },
} as const satisfies Record<string, EndpointDef>;

/**
 * The executor contract as operations the server implements: the executor
 * calls them, over the transport every contract has. Nothing new is
 * transported here — the server pushes offers, interrupts and replies on the
 * existing realtime contract below.
 */
export function defineAgentExecutorContract<TScope extends string>(config: {
  scope: TScope;
  /** Route prefix; default `agent-executor`. */
  prefix?: string | undefined;
}): ContractDef<typeof agentExecutorEndpoints, TScope> {
  return defineContract(
    { prefix: config.prefix ?? 'agent-executor', scope: config.scope },
    agentExecutorEndpoints,
  );
}

/** The events the server pushes to a connected executor. */
const agentExecutorServerEvents = {
  'turn:offer': { args: z.tuple([TurnOfferSchema]) },
  'turn:interrupt': { args: z.tuple([TurnInterruptSchema]) },
  'turn:reply': { args: z.tuple([InteractionReplySchema]) },
} satisfies RealtimeEventRegistry;

/** What the server pushes to a connected executor; the executor sends nothing on it. */
export const agentExecutorRealtimeContract: RealtimeContract<
  typeof agentExecutorServerEvents,
  Record<never, never>
> = defineRealtimeContract({ serverToClient: agentExecutorServerEvents, clientToServer: {} });
