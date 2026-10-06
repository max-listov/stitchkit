/** Error code of a generated beside-loader that runs inside a bundle built without the packaging plugin. */
export const NATIVE_NOT_PACKAGED = 'STITCHKIT_NATIVE_NOT_PACKAGED';

const messages = {
  architecture: 'The packaged Darwin backend does not support this architecture',
  packaging:
    'The Darwin backend is not packaged into this bundle: build it with createNativePackaging from stitchkit/files/packaging',
  resolve: 'The packaged Darwin backend is missing',
  load: 'The packaged Darwin backend could not be loaded',
  surface: 'The packaged Darwin backend has an invalid surface',
};
type Stage = keyof typeof messages;
const nativeCodes = new Set([
  NATIVE_NOT_PACKAGED,
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
  'ENOENT',
  'EINVAL',
  'EPERM',
  'EACCES',
  'ENOTSUP',
]);

export function darwinNativeCode(cause: unknown): string | undefined {
  let current = cause;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      nativeCodes.has(current.code)
    ) {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Which stage a failed addon load stopped at: a bundle built without the packaging plugin, an
 * addon that is not where the loader looked, or one that was found and did not load.
 */
export function darwinLoadStage(cause: unknown): 'packaging' | 'resolve' | 'load' {
  const code = darwinNativeCode(cause);
  if (code === NATIVE_NOT_PACKAGED) return 'packaging';
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT'
    ? 'resolve'
    : 'load';
}

/** Live callers retain the original Error; operator JSON only carries safe loader evidence. */
export class DarwinBackendError extends Error {
  readonly code = 'DARWIN_BACKEND_UNAVAILABLE';
  constructor(
    readonly stage: Stage,
    cause?: unknown,
  ) {
    super(messages[stage], { cause });
    this.name = 'DarwinBackendError';
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      architecture: process.arch,
      message: this.message,
      nativeCode: darwinNativeCode(this.cause),
    };
  }
}
