import { connect, type Socket } from 'node:net';

/** Bun's runtime accepts an inherited socket fd here before its Node types expose the overload. */
export function connectOwnerLossSocket(fd: number): Socket {
  return Reflect.apply(connect, undefined, [{ fd }]);
}
