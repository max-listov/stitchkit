/**
 * The directory inbox — delivers each entry another program drops into a
 * directory to the application at least once.
 *
 * Its own entrypoint because it reads, renames and removes files (`node:fs`),
 * and `stitchkit/application` must stay importable in a browser. Its contract —
 * the configuration, the delivery, the state and rejection schemas — stays in
 * `stitchkit/application`, as the diagnostic journal's does. → ADR 0156.
 */
export { createDirectoryInbox } from '../../application/directory-inbox';
