/** Request identity stays native: cloning it would break runtime timeout/upgrade APIs. */
interface StreamLifetime {
  cancel(): void;
  settled: Promise<void>;
}

interface RequestStreams {
  add(stream: StreamLifetime): void;
}

const requests = new WeakMap<Request, RequestStreams>();

/** Abort-aware I/O may reject with the signal reason or wrap it as its cause. */
export function isStreamCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason ||
      (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason))
  );
}

/** Internal bridge between Fetch-clean streaming routes and their managed server. */
export function ownHttpStream(request: Request, stream: StreamLifetime): void {
  requests.get(request)?.add(stream);
}

export async function settleStreamCleanup(
  operations: readonly Promise<unknown>[],
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, 'HTTP stream source did not close cleanly');
}

export function createHttpStreamTracker() {
  const streams = new Map<StreamLifetime, Request>();
  const failures: unknown[] = [];
  let draining = false;

  const assertClean = () => {
    if (failures.length) {
      throw new AggregateError(failures, '[stitchkit] HTTP stream cleanup failed');
    }
  };
  return {
    bind(request: Request, onComplete: () => void): () => void {
      let handlerDone = false;
      let pending = 0;
      const complete = () => {
        if (!handlerDone || pending !== 0) return;
        requests.delete(request);
        onComplete();
      };
      requests.set(request, {
        add(stream) {
          pending += 1;
          streams.set(stream, request);
          void stream.settled.then(
            () => {
              streams.delete(stream);
              pending -= 1;
              complete();
            },
            (error: unknown) => {
              if (draining) failures.push(error);
              else console.error('[stitchkit] HTTP stream cleanup failed:', error);
              streams.delete(stream);
              pending -= 1;
              complete();
            },
          );
          if (draining) stream.cancel();
        },
      });
      return () => {
        handlerDone = true;
        complete();
      };
    },
    get pendingRequests(): number {
      return new Set(streams.values()).size;
    },
    cancel() {
      draining = true;
      for (const stream of streams.keys()) stream.cancel();
    },
    assertClean,
    async drain() {
      while (streams.size) {
        await Promise.allSettled([...streams.keys()].map((stream) => stream.settled));
      }
      assertClean();
    },
  };
}
