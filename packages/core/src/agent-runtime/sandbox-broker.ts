import { chmod, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SandboxError, type SandboxNetworkPolicy } from './sandbox-contract';

/** Explicit HTTP gateway over a Unix socket; CONNECT and arbitrary TCP are never exposed. */
export async function createSandboxBroker(
  socketPath: string,
  getPolicy: () => SandboxNetworkPolicy,
  onError: (cause: unknown) => void,
) {
  const controllers = new Set<AbortController>();
  const maxBytes = 1_048_576;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const policy = getPolicy();
    const rule =
      typeof policy === 'object'
        ? policy.allow.find((entry) => new URL(entry.origin).host === req.headers.host)
        : undefined;
    if (!rule || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(403).end('Sandbox network denied');
      return;
    }
    if (controllers.size >= 16) {
      res.writeHead(503).end('Sandbox broker busy');
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => {
      controller.abort();
      req.destroy();
    }, 30_000);
    timer.unref();
    const abort = () => controller.abort();
    req.on('aborted', abort);
    res.on('close', abort);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes)
          throw new SandboxError('SANDBOX_LIMIT', 'Sandbox request limit exceeded');
        chunks.push(bytes);
      }
      const target = new URL(req.url, rule.origin);
      if (target.origin !== new URL(rule.origin).origin)
        throw new SandboxError('SANDBOX_NETWORK_DENIED', 'Sandbox network denied');
      const headers = new Headers();
      for (const name of ['content-type', 'accept']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      for (const [name, value] of Object.entries(rule.headers ?? {})) headers.set(name, value);
      const response = await fetch(target, {
        method: req.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(size > 0 && { body: Buffer.concat(chunks) }),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SandboxError('SANDBOX_NETWORK_DENIED', 'Sandbox redirects are denied');
      }
      const reader = response.body?.getReader();
      const output: Uint8Array[] = [];
      size = 0;
      try {
        while (reader) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes)
            throw new SandboxError('SANDBOX_LIMIT', 'Sandbox response limit exceeded');
          output.push(next.value);
        }
      } finally {
        await reader?.cancel();
      }
      const type = response.headers.get('content-type');
      res.writeHead(response.status, type ? { 'content-type': type } : {});
      res.end(Buffer.concat(output));
    } catch (cause) {
      try {
        onError(cause);
      } catch (observerError) {
        process.emitWarning(
          new Error('Sandbox diagnostic sink failed', {
            cause: new AggregateError([cause, observerError]),
          }),
        );
      }
      // Upstream diagnostics may contain credentials; only a generic gateway failure crosses back.
      if (!res.destroyed) res.writeHead(502).end('Sandbox upstream request failed');
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      req.off('aborted', abort);
      res.off('close', abort);
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.on('connect', (_req, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
  );
  server.requestTimeout = 30_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    abortRequests() {
      for (const controller of controllers) controller.abort();
    },
    async close() {
      for (const controller of controllers) controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await unlink(socketPath).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          throw error;
      });
    },
  };
}
