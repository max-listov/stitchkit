import { z } from 'zod';
import { MAX_TIMER_MS } from '../internal/timers';
import { transportResult } from '../internal/typed';
import {
  defineRealtimeContract,
  type RealtimeContract,
  type RealtimeEventDefinition,
  type RealtimeEventRegistry,
} from './contract';

/** Default Socket.IO event prefix used by `createDevicePresenceContract`. */
export const DEFAULT_DEVICE_PRESENCE_PREFIX = 'stitchkit.device-presence';

/** Default server-side remote command timeout in milliseconds. */
export const DEFAULT_DEVICE_PRESENCE_COMMAND_TIMEOUT_MS = 10_000;

/** Default client-side announce / state-update request timeout in milliseconds. */
export const DEFAULT_DEVICE_PRESENCE_REQUEST_TIMEOUT_MS = 10_000;

/** Structured error codes returned by device presence operations and remote commands. */
export const DevicePresenceErrorCodeSchema = z.enum([
  'DEVICE_OFFLINE',
  'FORBIDDEN',
  'TIMEOUT',
  'UNSUPPORTED_CAPABILITY',
  'HANDLER_ERROR',
  'INVALID_COMMAND',
  'DISCONNECTED',
]);
/** Inferred device presence error code union. */
export type DevicePresenceErrorCode = z.infer<typeof DevicePresenceErrorCodeSchema>;

/** Identity metadata a client announces for the current online device. */
export const DevicePresenceIdentitySchema = z.strictObject({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
});
/** Inferred online device identity metadata. */
export type DevicePresenceIdentity = z.infer<typeof DevicePresenceIdentitySchema>;

/** Reusable capability state schema for advertising a desktop or mobile relay host's liveness. */
export const DevicePresenceRelayStateSchema = z.strictObject({
  status: z.enum(['idle', 'registering', 'online', 'disconnected', 'refused', 'closed']),
  deviceId: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  leaseExpiresAt: z.number().int().positive().optional(),
});
/** Inferred live relay host capability state. */
export type DevicePresenceRelayState = z.infer<typeof DevicePresenceRelayStateSchema>;

/** One capability slot definition: live state schema, command payload schema and optional ack result schema. */
export interface DevicePresenceCapabilityDef<
  TState extends z.ZodType = z.ZodType,
  TCommand extends z.ZodType = z.ZodType,
  TResult extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly state: TState;
  readonly command: TCommand;
  readonly result?: TResult;
}

/** Map of capability names to their strict Zod state and command schemas. */
export type DevicePresenceCapabilityMap = Record<string, DevicePresenceCapabilityDef>;

/** Capability names declared on a `DevicePresenceContract`. */
export type DevicePresenceCapabilityKey<TCaps extends DevicePresenceCapabilityMap> = Extract<
  keyof TCaps,
  string
>;

/** Parsed live state slots advertised by one online device. */
export type DevicePresenceStates<TCaps extends DevicePresenceCapabilityMap> = {
  readonly [K in DevicePresenceCapabilityKey<TCaps>]?: z.output<TCaps[K]['state']>;
};

/** Input live state slots accepted when announcing or seeding a device presence client. */
export type DevicePresenceStatesInput<TCaps extends DevicePresenceCapabilityMap> = {
  readonly [K in DevicePresenceCapabilityKey<TCaps>]?: z.input<TCaps[K]['state']>;
};

/** Command result payload type for capability `K` (`unknown` when no `result` schema was declared). */
export type DevicePresenceCapabilityResult<
  TCaps extends DevicePresenceCapabilityMap,
  K extends DevicePresenceCapabilityKey<TCaps>,
> = TCaps[K]['result'] extends z.ZodType ? z.output<TCaps[K]['result']> : unknown;

/** One online device entry within an account's presence snapshot. */
export interface DevicePresenceDevice<TCaps extends DevicePresenceCapabilityMap> {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly connectedAt: string;
  readonly capabilities: readonly DevicePresenceCapabilityKey<TCaps>[];
  readonly states: DevicePresenceStates<TCaps>;
}

/** Account-scoped snapshot of currently online devices and their live capability states. */
export interface DevicePresenceSnapshot<TCaps extends DevicePresenceCapabilityMap> {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly revision: number;
  readonly devices: readonly DevicePresenceDevice<TCaps>[];
}

/** Client-to-server announce frame registering a device on the current authenticated socket. */
export interface DevicePresenceAnnouncePayload<TCaps extends DevicePresenceCapabilityMap> {
  readonly schemaVersion: 1;
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly capabilities?: readonly DevicePresenceCapabilityKey<TCaps>[];
  readonly states?: DevicePresenceStatesInput<TCaps>;
}

/** Structured acknowledgement returned for an announce request. */
export type DevicePresenceAnnounceAck<TCaps extends DevicePresenceCapabilityMap> =
  | {
      readonly schemaVersion: 1;
      readonly outcome: 'ok';
      readonly snapshot: DevicePresenceSnapshot<TCaps>;
    }
  | {
      readonly schemaVersion: 1;
      readonly outcome: 'error';
      readonly code: DevicePresenceErrorCode;
      readonly message: string;
    };

/** Client-to-server live state update (`state: null` clears the capability slot). */
export type DevicePresenceStateUpdatePayload<TCaps extends DevicePresenceCapabilityMap> = {
  readonly [K in DevicePresenceCapabilityKey<TCaps>]: {
    readonly schemaVersion: 1;
    readonly capability: K;
    readonly state: z.input<TCaps[K]['state']> | null;
  };
}[DevicePresenceCapabilityKey<TCaps>];

/** Structured acknowledgement returned for a state publication request. */
export type DevicePresenceStateUpdateAck =
  | {
      readonly schemaVersion: 1;
      readonly outcome: 'ok';
      readonly revision: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly outcome: 'error';
      readonly code: DevicePresenceErrorCode;
      readonly message: string;
    };

/** Client-to-server remote command request addressed to one device in the same account. */
export type DevicePresenceCommandRequest<TCaps extends DevicePresenceCapabilityMap> = {
  readonly [K in DevicePresenceCapabilityKey<TCaps>]: {
    readonly schemaVersion: 1;
    readonly commandId: string;
    readonly targetDeviceId: string;
    readonly capability: K;
    readonly command: z.input<TCaps[K]['command']>;
    readonly timeoutMs?: number;
  };
}[DevicePresenceCapabilityKey<TCaps>];

/** Server-to-target-device command delivery envelope. */
export type DevicePresenceCommandDelivery<TCaps extends DevicePresenceCapabilityMap> = {
  readonly [K in DevicePresenceCapabilityKey<TCaps>]: {
    readonly schemaVersion: 1;
    readonly commandId: string;
    readonly fromDeviceId: string;
    readonly capability: K;
    readonly command: z.output<TCaps[K]['command']>;
  };
}[DevicePresenceCapabilityKey<TCaps>];

/** Structured result returned for a targeted remote command. */
export type DevicePresenceCommandResult<TResult = unknown> =
  | {
      readonly schemaVersion: 1;
      readonly commandId: string;
      readonly outcome: 'ok';
      readonly result?: TResult;
    }
  | {
      readonly schemaVersion: 1;
      readonly commandId: string;
      readonly outcome: 'error';
      readonly code: DevicePresenceErrorCode;
      readonly message: string;
    };

/** Wire event names generated by `createDevicePresenceContract`. */
export interface DevicePresenceEventNames {
  readonly announce: string;
  readonly setState: string;
  readonly sendCommand: string;
  readonly commandDeliver: string;
  readonly commandResult: string;
  readonly snapshot: string;
}

/** Options for `createDevicePresenceContract`. */
export interface DevicePresenceContractOptions {
  /** Event namespace prefix on the shared Socket.IO connection (default `'stitchkit.device-presence'`). */
  readonly eventPrefix?: string;
}

/** Strict Zod schemas assembled for one `DevicePresenceContract`. */
export interface DevicePresenceSchemas<TCaps extends DevicePresenceCapabilityMap> {
  readonly states: z.ZodType<DevicePresenceStates<TCaps>>;
  readonly device: z.ZodType<DevicePresenceDevice<TCaps>>;
  readonly snapshot: z.ZodType<DevicePresenceSnapshot<TCaps>>;
  readonly announce: z.ZodType<DevicePresenceAnnouncePayload<TCaps>>;
  readonly announceAck: z.ZodType<DevicePresenceAnnounceAck<TCaps>>;
  readonly stateUpdate: z.ZodType<DevicePresenceStateUpdatePayload<TCaps>>;
  readonly stateUpdateAck: z.ZodType<DevicePresenceStateUpdateAck>;
  readonly commandRequest: z.ZodType<DevicePresenceCommandRequest<TCaps>>;
  readonly commandDelivery: z.ZodType<DevicePresenceCommandDelivery<TCaps>>;
  readonly commandResult: z.ZodType<DevicePresenceCommandResult>;
}

/** Capability-driven presence and remote-command contract shared by server and client. */
export interface DevicePresenceContract<TCaps extends DevicePresenceCapabilityMap> {
  readonly capabilities: TCaps;
  readonly eventPrefix: string;
  readonly events: DevicePresenceEventNames;
  readonly schemas: DevicePresenceSchemas<TCaps>;
  readonly realtime: RealtimeContract<RealtimeEventRegistry, RealtimeEventRegistry>;
}

const StateUpdateAckSchema: z.ZodType<DevicePresenceStateUpdateAck> = z.discriminatedUnion(
  'outcome',
  [
    z.strictObject({
      schemaVersion: z.literal(1),
      outcome: z.literal('ok'),
      revision: z.number().int().nonnegative(),
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      outcome: z.literal('error'),
      code: DevicePresenceErrorCodeSchema,
      message: z.string().min(1),
    }),
  ],
);

const CommandResultSchema: z.ZodType<DevicePresenceCommandResult> = z.discriminatedUnion(
  'outcome',
  [
    z.strictObject({
      schemaVersion: z.literal(1),
      commandId: z.string().min(1),
      outcome: z.literal('ok'),
      result: z.unknown().optional(),
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      commandId: z.string().min(1),
      outcome: z.literal('error'),
      code: DevicePresenceErrorCodeSchema,
      message: z.string().min(1),
    }),
  ],
);

function buildVariantUnion<TVariant extends z.ZodObject>(
  variants: readonly TVariant[],
): z.ZodType<unknown> {
  const [first, second, ...rest] = variants;
  if (!first) return z.never();
  if (!second) return first;
  return z.discriminatedUnion('capability', [first, second, ...rest]);
}

/**
 * Define a strict, capability-driven realtime contract for account-scoped online device presence,
 * ephemeral capability state slots and targeted remote commands over a shared Socket.IO connection.
 */
export function createDevicePresenceContract<const TCaps extends DevicePresenceCapabilityMap>(
  capabilities: TCaps,
  options: DevicePresenceContractOptions = {},
): DevicePresenceContract<TCaps> {
  const eventPrefix = options.eventPrefix ?? DEFAULT_DEVICE_PRESENCE_PREFIX;
  if (!eventPrefix.trim()) {
    throw new TypeError('DevicePresenceContractOptions.eventPrefix cannot be empty');
  }

  const keys = Object.keys(capabilities);
  for (const key of keys) {
    if (!key.trim()) {
      throw new TypeError('Device presence capability name cannot be empty');
    }
  }

  const capabilityKeySchema = z
    .string()
    .refine((value) => Object.hasOwn(capabilities, value), {
      message: 'Unknown device presence capability',
    });

  const stateShape: Record<string, z.ZodType> = {};
  const stateUpdateVariants: z.ZodObject[] = [];
  const commandRequestVariants: z.ZodObject[] = [];
  const commandDeliveryVariants: z.ZodObject[] = [];

  for (const key of keys) {
    const def = capabilities[key];
    if (!def) continue;
    stateShape[key] = def.state.optional();
    stateUpdateVariants.push(
      z.strictObject({
        schemaVersion: z.literal(1),
        capability: z.literal(key),
        state: z.union([def.state, z.null()]),
      }),
    );
    commandRequestVariants.push(
      z.strictObject({
        schemaVersion: z.literal(1),
        commandId: z.string().min(1),
        targetDeviceId: z.string().min(1),
        capability: z.literal(key),
        command: def.command,
        timeoutMs: z.number().int().min(1).max(MAX_TIMER_MS).optional(),
      }),
    );
    commandDeliveryVariants.push(
      z.strictObject({
        schemaVersion: z.literal(1),
        commandId: z.string().min(1),
        fromDeviceId: z.string().min(1),
        capability: z.literal(key),
        command: def.command,
      }),
    );
  }

  const statesSchema = z.strictObject(stateShape);
  const deviceSchema = z.strictObject({
    deviceId: z.string().min(1),
    name: z.string().min(1),
    platform: z.string().min(1),
    connectedAt: z.string().min(1),
    capabilities: z.array(capabilityKeySchema),
    states: statesSchema,
  });
  const snapshotSchema = z.strictObject({
    schemaVersion: z.literal(1),
    accountId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    devices: z.array(deviceSchema),
  });
  const announceSchema = z.strictObject({
    schemaVersion: z.literal(1),
    deviceId: z.string().min(1),
    name: z.string().min(1),
    platform: z.string().min(1),
    capabilities: z.array(capabilityKeySchema).optional(),
    states: statesSchema.optional(),
  });
  const announceAckSchema = z.discriminatedUnion('outcome', [
    z.strictObject({
      schemaVersion: z.literal(1),
      outcome: z.literal('ok'),
      snapshot: snapshotSchema,
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      outcome: z.literal('error'),
      code: DevicePresenceErrorCodeSchema,
      message: z.string().min(1),
    }),
  ]);
  const stateUpdateSchema = buildVariantUnion(stateUpdateVariants);
  const commandRequestSchema = buildVariantUnion(commandRequestVariants);
  const commandDeliverySchema = buildVariantUnion(commandDeliveryVariants);

  const events: DevicePresenceEventNames = {
    announce: `${eventPrefix}.announce`,
    setState: `${eventPrefix}.set-state`,
    sendCommand: `${eventPrefix}.command`,
    commandDeliver: `${eventPrefix}.command-deliver`,
    commandResult: `${eventPrefix}.command-result`,
    snapshot: `${eventPrefix}.snapshot`,
  };

  const serverToClient: Record<string, RealtimeEventDefinition> = {
    [events.snapshot]: { args: z.tuple([snapshotSchema]) },
    [events.commandDeliver]: { args: z.tuple([commandDeliverySchema]) },
  };
  const clientToServer: Record<string, RealtimeEventDefinition> = {
    [events.announce]: { args: z.tuple([announceSchema]), ack: announceAckSchema },
    [events.setState]: { args: z.tuple([stateUpdateSchema]), ack: StateUpdateAckSchema },
    [events.sendCommand]: { args: z.tuple([commandRequestSchema]), ack: CommandResultSchema },
    [events.commandResult]: { args: z.tuple([CommandResultSchema]) },
  };

  const schemas: DevicePresenceSchemas<TCaps> = {
    states: transportResult(statesSchema),
    device: transportResult(deviceSchema),
    snapshot: transportResult(snapshotSchema),
    announce: transportResult(announceSchema),
    announceAck: transportResult(announceAckSchema),
    stateUpdate: transportResult(stateUpdateSchema),
    stateUpdateAck: StateUpdateAckSchema,
    commandRequest: transportResult(commandRequestSchema),
    commandDelivery: transportResult(commandDeliverySchema),
    commandResult: CommandResultSchema,
  };

  return {
    capabilities,
    eventPrefix,
    events,
    schemas,
    realtime: defineRealtimeContract({ serverToClient, clientToServer }),
  };
}
