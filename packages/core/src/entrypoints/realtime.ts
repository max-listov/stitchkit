/** Realtime clients for native bundles: the caller supplies a literal Socket.IO peer loader. */

export {
  createDevicePresenceClient,
  type DevicePresenceClient,
  type DevicePresenceClientConfig,
  type DevicePresenceCommandContext,
  type DevicePresenceCommandHandler,
  type DevicePresenceSendCommandInput,
  type DevicePresenceSubscriber,
} from '../browser/device-presence-client';
export {
  createDevicePresenceRelayAdapter,
  type DevicePresenceRelayAdapter,
  type DevicePresenceRelayAdapterConfig,
  type DevicePresenceRelayStateSource,
} from '../browser/device-presence-relay-adapter';
export {
  type BindRealtimeClientOptions,
  type BoundRealtimeClient,
  bindRealtimeClient,
  type RealtimeClientTransport,
} from '../browser/realtime-client';
export { createRetainedTopics, type RetainedTopics } from '../browser/retained';
export type {
  RealtimeClient,
  RealtimeClientOptions,
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
  SocketIOClientPeerLoaders,
} from '../browser/socket-io-contract';
export {
  createRealtimeClient,
  createSocketIOClient,
} from '../browser/socket-io-explicit-peer';
export {
  defineRealtimeContract,
  type InferRealtimeEventMap,
  type RealtimeContract,
  type RealtimeEventRegistry,
} from '../realtime/contract';
export {
  createDevicePresenceContract,
  DEFAULT_DEVICE_PRESENCE_COMMAND_TIMEOUT_MS,
  DEFAULT_DEVICE_PRESENCE_PREFIX,
  DEFAULT_DEVICE_PRESENCE_REQUEST_TIMEOUT_MS,
  type DevicePresenceAnnounceAck,
  type DevicePresenceAnnouncePayload,
  type DevicePresenceCapabilityDef,
  type DevicePresenceCapabilityKey,
  type DevicePresenceCapabilityMap,
  type DevicePresenceCapabilityResult,
  type DevicePresenceCommandDelivery,
  type DevicePresenceCommandRequest,
  type DevicePresenceCommandResult,
  type DevicePresenceContract,
  type DevicePresenceContractOptions,
  type DevicePresenceDevice,
  type DevicePresenceErrorCode,
  DevicePresenceErrorCodeSchema,
  type DevicePresenceEventNames,
  type DevicePresenceIdentity,
  DevicePresenceIdentitySchema,
  type DevicePresenceRelayState,
  DevicePresenceRelayStateSchema,
  type DevicePresenceSchemas,
  type DevicePresenceSnapshot,
  type DevicePresenceStates,
  type DevicePresenceStatesInput,
  type DevicePresenceStateUpdateAck,
  type DevicePresenceStateUpdatePayload,
} from '../realtime/device-presence-contract';
