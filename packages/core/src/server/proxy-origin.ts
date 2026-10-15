import { z } from 'zod';
import type { BunServer } from './bun';

/** One TCP ingress that overwrites Host/proto and strips competing URL headers. */
export interface ProxyOriginConfig {
  /** Match the real socket peer, never a forwarded client IP. */
  trustedPeer: (socketIp: string) => boolean;
}

const ProtocolSchema = z.enum(['http', 'https']);
const AuthoritySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\s/\\?#@,;]+$/);
const conflictingHeaders = ['forwarded', 'x-forwarded-host', 'x-forwarded-port'];

/** Bun associates requestIP, timeout and upgrade with the original native request. */
export function createProxyOrigin(policy: ProxyOriginConfig) {
  const originals = new WeakMap<Request, Request>();
  const original = (request: Request) => originals.get(request) ?? request;

  return {
    bind(server: BunServer): void {
      const requestIP = server.requestIP.bind(server);
      const timeout = server.timeout.bind(server);
      const upgrade = server.upgrade.bind(server);
      server.requestIP = (request) => requestIP(original(request));
      server.timeout = (request, seconds) => timeout(original(request), seconds);
      server.upgrade = (request, options) => upgrade(original(request), options);
    },
    normalize(request: Request, server: BunServer): Request | Response {
      const peer = server.requestIP(request)?.address;
      // A forwarded client IP is never a source of ingress trust. A missing peer,
      // including a unix listener, cannot satisfy this TCP ingress policy.
      if (!peer || !policy.trustedPeer(peer)) return request;
      const protocol = ProtocolSchema.safeParse(request.headers.get('x-forwarded-proto'));
      const authority = AuthoritySchema.safeParse(request.headers.get('host'));
      if (
        !protocol.success ||
        !authority.success ||
        conflictingHeaders.some((name) => request.headers.has(name))
      ) {
        return new Response('Invalid proxy origin', { status: 400 });
      }
      let origin: URL;
      try {
        // Read the wire authority: an explicit :80 is lost by an internal HTTP URL,
        // but remains meaningful on the external HTTPS origin (and vice versa).
        origin = new URL(`${protocol.data}://${authority.data}`);
      } catch {
        return new Response('Invalid proxy origin', { status: 400 });
      }
      const url = new URL(request.url);
      url.protocol = origin.protocol;
      url.host = origin.host;
      url.port = origin.port;
      if (url.href === request.url) return request;
      const normalized = new Request(url, request);
      originals.set(normalized, request);
      return normalized;
    },
  };
}
