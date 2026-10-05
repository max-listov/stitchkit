/**
 * File metadata (device, inode, size, link count, times) captured at one moment, used to tell
 * whether a file changed between reads. It lives apart from the descriptor readers so the public
 * declarations that name it do not pull in a file-handle type.
 */
export interface FileObservation {
  dev: number;
  ino: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}
