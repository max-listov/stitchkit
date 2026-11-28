export declare const DEFAULT_NPM_INSTALL_BACKOFF_MS: readonly number[];

export interface RunBunInstallRetryInfo {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly reason: string;
}

export interface RunBunInstallOptions {
  readonly delaysMs?: readonly number[];
  readonly timeoutMs?: number;
  readonly exec?: (cwd: string, args: readonly string[]) => string;
  readonly sleep?: (delayMs: number) => void;
  readonly onRetry?: (info: RunBunInstallRetryInfo) => void;
}

export declare function isTransientNpmInstallError(output: unknown): boolean;
export declare function sleepSync(delayMs: number): void;
export declare function runBunInstall(
  cwd: string,
  args?: readonly string[],
  options?: RunBunInstallOptions,
): string;
