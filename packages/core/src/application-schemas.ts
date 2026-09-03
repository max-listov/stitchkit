/**
 * The application's schemas, and nothing else.
 *
 * A separate entry because `stitchkit/application` is the server runtime: it
 * reaches `node:child_process`, `node:fs` and `node:crypto`, and a bundler
 * that stubs those does not fail at the call — it fails while initialising the
 * module, taking the whole page with it. So a contract whose `output` is an
 * application snapshot could be declared but never consumed from a browser,
 * which is the one thing a contract is for.
 *
 * The list lives here rather than in `application.ts`, which re-exports this
 * file: two copies of it would be two public surfaces free to drift apart.
 */
export {
  type ApplicationAdmissionSnapshot,
  ApplicationAdmissionSnapshotSchema,
  type ApplicationHealth,
  ApplicationHealthSchema,
  type ApplicationId,
  ApplicationIdSchema,
  type ApplicationLifecycle,
  ApplicationLifecycleSchema,
  type ApplicationResourceShutdown,
  ApplicationResourceShutdownSchema,
  type ApplicationShutdownResult,
  ApplicationShutdownResultSchema,
  type ApplicationSnapshot,
  ApplicationSnapshotSchema,
  type ApplicationStatusProjection,
  ApplicationStatusProjectionSchema,
  type ManagedResourceSnapshot,
  ManagedResourceSnapshotSchema,
  type ManagedResourceState,
  ManagedResourceStateSchema,
  projectApplicationStatus,
} from './application/schemas';
