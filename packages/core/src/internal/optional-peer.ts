/**
 * Telling "the package is not there" apart from "the loader itself threw".
 *
 * Both halves of the Socket.IO adapter resolve their optional peers through a
 * variable specifier and both accept an injected loader, so both face the same
 * question when a load fails — and both must answer it the same way. A loader
 * that throws for its own reasons is not a packaging problem, and reporting it
 * as one sends the reader after the wrong thing.
 *
 * Pure and dependency-free, so the browser half can share it without dragging
 * anything from the server into a browser graph.
 */
export function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? error.code : undefined;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    message.includes('Cannot find module') ||
    message.includes('Cannot find package')
  );
}
