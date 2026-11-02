/**
 * `stitchkit/tracking/contract` — the wire shapes of tracking: the contract
 * factory, the event and visit schemas, and the performance sample with its
 * trust threshold. It brings `zod`, so it belongs to the server and to a shared
 * contract, and browser code that sends events does not import it. → ADR 0280.
 */
export {
  createTrackingContract,
  type TrackingContractConfig,
  type TrackingContractEndpoints,
} from '../../tracking/contract';
export {
  type PerformanceSample,
  PerformanceSampleSchema,
  type PerformanceVitals,
  PerformanceVitalsSchema,
} from '../../tracking/performance/schema';
export {
  type PerformanceMetricSummary,
  summarizePerformanceMetric,
} from '../../tracking/performance/summary';
export {
  type AttributionData,
  AttributionDataSchema,
  createTrackingSchemas,
  DEFAULT_BUILD_ID_PATTERN,
  type TrackEventsRequest,
  type TrackEventsResponse,
  TrackEventsResponseSchema,
  type TrackingDisposition,
  TrackingDispositionSchema,
  type TrackingDispositionStatus,
  TrackingDispositionStatusSchema,
  type TrackingEventEnvelope,
  type TrackingEventShape,
  type TrackingOutboxState,
  TrackingOutboxStateSchema,
  type TrackingSchemas,
  type TrackingSchemasConfig,
  type UtmData,
  UtmDataSchema,
  type VisitBootstrapResponse,
  VisitBootstrapResponseSchema,
  type VisitEntryContext,
  type VisitEntryContextShape,
} from '../../tracking/schemas';
