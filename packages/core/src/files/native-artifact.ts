import { nativeLoaderMarker } from './native-packaging-layout';

/**
 * Which Darwin loader an artifact carries: `packaged` (the static loader a packaging plugin
 * wrote), `unpackaged` (the default loader, which refuses the addon inside a bundle) or
 * `no-loader` (nothing in it loads the addon). An artifact with both reads `unpackaged`: one
 * unpackaged loader is enough for its calls to refuse on macOS.
 */
export type NativeArtifactLoader = 'packaged' | 'unpackaged' | 'no-loader';

function contains(bytes: Uint8Array, text: string): boolean {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Bun stores source text with any non-ASCII character as UTF-16, so both encodings are read.
  return (
    haystack.includes(Buffer.from(text, 'latin1')) ||
    haystack.includes(Buffer.from(text, 'utf16le'))
  );
}

/**
 * Classify a built artifact (a JS bundle or a compiled executable) by the marker every generated
 * loader carries, without running it. Reads the bytes only; builds made before the marker existed
 * (0.107.0 and earlier) read `no-loader`.
 */
export function inspectNativeArtifact(bytes: Uint8Array): NativeArtifactLoader {
  if (contains(bytes, nativeLoaderMarker('unpackaged'))) return 'unpackaged';
  if (contains(bytes, nativeLoaderMarker('packaged'))) return 'packaged';
  return 'no-loader';
}
