import type { z } from 'zod';
import { type ContractDef, defineContract } from '../contract';
import {
  createTrackingSchemas,
  type TrackingEventShape,
  type TrackingSchemas,
  type TrackingSchemasConfig,
} from './schemas';

export interface TrackingContractConfig<
  TType extends string,
  TExtras extends z.ZodRawShape | undefined,
  TScope extends string,
> extends TrackingSchemasConfig<TType, TExtras> {
  /** Route prefix; default `tracking`. */
  prefix?: string;
  /**
   * Almost always the application's public scope: the landing page and the
   * sign-in page are read by anonymous visitors, and their path is part of the
   * funnel. Identity, when there is one, comes from the cookie on the server
   * side; the client claims nothing about itself.
   */
  scope: TScope;
  /** Byte ceiling for one batch; default 256 KiB. */
  maxJsonBodyBytes?: number;
}

/** The two operations every tracking surface has, typed by the application's schemas. */
export type TrackingContractEndpoints<TSchemas extends TrackingSchemas<z.ZodObject>> = {
  bootstrap: {
    method: 'POST';
    path: '/visit';
    expose: readonly ['HTTP'];
    desc: string;
    input: TSchemas['entry'];
    output: TSchemas['bootstrap'];
  };
  track: {
    method: 'POST';
    path: '/events';
    expose: readonly ['HTTP'];
    desc: string;
    input: TSchemas['request'];
    output: TSchemas['response'];
    safelistedBody: true;
    maxJsonBodyBytes: number;
  };
};

/**
 * `bootstrap` issues or renews a visit lease; `track` receives a batch. `track`
 * declares `safelistedBody` because the page-leave event is sent by
 * `sendUnloadBeacon` with a string body — the only body a document that is
 * being unloaded can deliver to another origin (ADR 0165) — and the server
 * therefore needs an explicit `cors.origin` allow-list for it to arrive.
 *
 * **Both endpoints are HTTP-only, and that is not a formality.** An endpoint
 * with no `expose` is a tool on MCP and AGENT by default, and this contract is
 * built here rather than by the application's own contract factory — so a
 * project that sets `toolExposure: 'explicit'` for everything it authors was
 * still handed a `track` tool it never asked for. An agent has nothing to gain
 * from a browser-event ingest and one thing to lose by having it: writes into
 * the application's visitor data, under its own name, indistinguishable
 * afterwards from a real visitor's. `bootstrap` said `['HTTP']` from the start;
 * `track` not saying it was an omission, not a decision.
 */
export function createTrackingContract<TType extends string, TScope extends string>(
  config: TrackingContractConfig<TType, undefined, TScope>,
): ContractDef<
  TrackingContractEndpoints<TrackingSchemas<z.ZodObject<TrackingEventShape<TType>>>>,
  TScope
>;
export function createTrackingContract<
  TType extends string,
  TExtras extends z.ZodRawShape,
  TScope extends string,
>(
  config: TrackingContractConfig<TType, TExtras, TScope>,
): ContractDef<
  TrackingContractEndpoints<TrackingSchemas<z.ZodObject<TrackingEventShape<TType> & TExtras>>>,
  TScope
>;
export function createTrackingContract(
  config: TrackingContractConfig<string, z.ZodRawShape | undefined, string>,
): ContractDef<TrackingContractEndpoints<TrackingSchemas<z.ZodObject>>, string> {
  const schemas = createTrackingSchemas(config);
  return defineContract(
    { prefix: config.prefix ?? 'tracking', scope: config.scope },
    {
      bootstrap: {
        method: 'POST',
        path: '/visit',
        expose: ['HTTP'],
        desc: 'Issue or renew a browser visit lease',
        input: schemas.entry,
        output: schemas.bootstrap,
      },
      track: {
        method: 'POST',
        path: '/events',
        expose: ['HTTP'],
        desc: 'Batch track browser events',
        input: schemas.request,
        output: schemas.response,
        safelistedBody: true,
        maxJsonBodyBytes: config.maxJsonBodyBytes ?? 256 * 1024,
      },
    },
  );
}
