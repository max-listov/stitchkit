/**
 * MCP Apps (SEP-1865) primitives — the generic transport plumbing for serving
 * interactive UI widgets. stitchkit owns the wiring (resource registration, the
 * `_meta.ui` passthrough on tools, the apps MIME type, the runtime-bundle
 * inliner); the application owns the widget HTML/CSS/JS and its product UI.
 *
 * Pair a tool's `ui.resourceUri` (contract `EndpointUiMeta`) with a resource of
 * the same `ui://…` uri registered through `McpServerBuildConfig.resources`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * MIME type a host uses to recognise an MCP Apps UI resource — it renders the
 * HTML as an interactive sandboxed iframe rather than displaying the source.
 */
export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

/** Placeholder a widget HTML file carries where the ext-apps runtime is inlined. */
export const EXT_APPS_BUNDLE_PLACEHOLDER = '/*__EXT_APPS_BUNDLE__*/';

/**
 * Content-Security-Policy allowlists a widget declares so the host's iframe can
 * reach external origins (maps to the host's CSP directives). Default is
 * block-all, so any external image / fetch origin must be listed.
 */
export interface McpAppCsp {
  /** `connect-src` — fetch / XHR / WebSocket origins. */
  connectDomains?: string[];
  /** `img-src` / `script-src` / `style-src` / `font-src` / `media-src` origins. */
  resourceDomains?: string[];
  /** `frame-src` — nested iframe origins (currently restricted in some hosts). */
  frameDomains?: string[];
  /** `base-uri` origins. */
  baseUriDomains?: string[];
}

/** UI metadata attached to a served resource's content (`_meta.ui`). */
export interface McpAppResourceMeta {
  csp?: McpAppCsp;
  /** Drop the host's outer card border (mobile). */
  prefersBorder?: boolean;
  /** Stable origin for external-API CORS allowlists. */
  domain?: string;
}

/**
 * A UI resource served over MCP. `read` returns the widget HTML (already
 * bundle-inlined). The default `mimeType` is the apps MIME type, so a plain
 * widget needs only `uri`, `name` and `read`.
 */
export interface McpResourceDef {
  /** `ui://…` uri — must match a tool's `ui.resourceUri`. */
  uri: string;
  /** Human-readable name (shown in `resources/list`). */
  name: string;
  /** MIME type — defaults to `RESOURCE_MIME_TYPE`. */
  mimeType?: string;
  /** Optional UI metadata (CSP, border, domain) applied to the content. */
  ui?: McpAppResourceMeta;
  /** Return the resource body — the widget HTML for an apps resource. */
  read: () => string | Promise<string>;
}

const require = createRequire(import.meta.url);

/**
 * Inline the `@modelcontextprotocol/ext-apps` browser runtime into a widget's
 * HTML, replacing `EXT_APPS_BUNDLE_PLACEHOLDER`. The iframe CSP blocks CDN
 * script fetches, so the runtime must be inlined at startup rather than
 * imported. `ext-apps` is an optional peer — a clear error is thrown if the
 * widget needs the bundle but the peer is not installed.
 *
 * The bundle's trailing `export{…}` is rewritten to `globalThis.ExtApps = {…}`
 * so an inline `<script type="module">` can read `globalThis.ExtApps`.
 */
export function inlineMcpAppBundle(html: string): string {
  if (!html.includes(EXT_APPS_BUNDLE_PLACEHOLDER)) return html;

  let bundlePath: string;
  try {
    bundlePath = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
  } catch {
    throw new Error(
      "[stitchkit] inlineMcpAppBundle: '@modelcontextprotocol/ext-apps' is not installed. " +
        'Add it as a dependency to serve MCP App widgets.',
    );
  }

  const bundle = readFileSync(bundlePath, 'utf8').replace(
    /export\{([^}]+)\};?\s*$/,
    (_match: string, body: string) =>
      `globalThis.ExtApps={${body
        .split(',')
        .map((pair: string) => {
          const [local, exported] = pair.split(' as ').map((s) => s.trim());
          return `${exported ?? local}:${local}`;
        })
        .join(',')}};`,
  );

  // Function replacer — a string replacement would interpret the `$…` sequences
  // the minified bundle is full of.
  return html.replace(EXT_APPS_BUNDLE_PLACEHOLDER, () => bundle);
}
