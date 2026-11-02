/**
 * `stitchkit/tracking/performance` — Web Vitals from real visitors, collected
 * after the page has loaded. The sample's schema and the report's trust threshold
 * are `stitchkit/tracking/contract`; tables and reports stay the application's.
 * Importing this needs the optional peer `web-vitals`. → ADR 0280.
 */
export {
  createPerformanceCollector,
  isLabUserAgent,
  type PerformanceCollector,
  type PerformanceCollectorConfig,
  type PerformanceHost,
  type VitalsLibrary,
  type VitalsMetric,
  type VitalsObserver,
} from '../../tracking/performance/collector';
