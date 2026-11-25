export {
  type ManagedFilePath,
  ManagedFilePathSchema,
  type ManagedFileRef,
  ManagedFileRefSchema,
} from '../contract/file-ref';
export type { FileObservation } from '../files/boundary';
export {
  createManagedFileBoundary,
  type ManagedFileBoundary,
  type ManagedFileBoundaryConfig,
  ManagedFileError,
  type ManagedFileErrorCode,
  type ManagedFileInspection,
  type ManagedFileInspectionInput,
  type ManagedFileInspector,
  type ManagedFileReadOptions,
  type ManagedFileSource,
  type ManagedFileWriteOptions,
} from '../files/boundary';
export {
  CHUNK_SPOOL_ERROR_CODES,
  type ChunkSpool,
  type ChunkSpoolAssembly,
  type ChunkSpoolConfig,
  type ChunkSpoolErrorCode,
  type ChunkSpoolKey,
  type ChunkSpoolOpen,
  type ChunkSpoolPart,
  createChunkSpool,
  isChunkSpoolErrorCode,
} from '../files/chunk-spool';
export { type WaitForDirectoryOptions, waitForDirectory } from '../files/directory-appearance';
export { type JsonFileReading, readJsonOnce } from '../files/json-file-reading';
export {
  MAX_POLLED_JSON_CACHE_BYTES,
  MAX_POLLED_JSON_PATHS,
  type PolledJsonChange,
  type PolledJsonEntry,
  PolledJsonFile,
  PolledJsonFiles,
  type PolledJsonOptions,
} from '../files/polled-json';
export {
  DEFAULT_JSON_FILE_BYTES,
  fileIdentity,
  type JsonValueRefusal,
  type JsonValueSchema,
  parseJsonBytes,
  type RegularFileAccept,
  type RegularFileAsyncReadOptions,
  RegularFileError,
  type RegularFileReadOptions,
  type RegularFileRefusal,
  readJsonFileSync,
  readRegularFile,
  readRegularFileSync,
} from '../files/regular-file';
export {
  type WriteFileAtomicOptions,
  writeFileAtomic,
  writeFileAtomicSync,
} from '../internal/atomic-file';
export { AtomicFilePublicationError } from '../internal/atomic-publication';
export {
  isAtomicStagingName,
  type SweepAtomicStagingOptions,
  sweepAtomicStaging,
} from '../internal/atomic-staging';
export type { FileIdentityStats, FileStatsView } from '../internal/file-observation';
export { bindUnixSocket, type UnixSocketBinding } from '../internal/unix-socket';
export {
  type ExclusiveLock,
  ExclusiveLockError,
  type ExclusiveLockOptions,
  type ExclusiveLockOwner,
  withExclusiveLock,
} from '../internal/with-exclusive-lock';
