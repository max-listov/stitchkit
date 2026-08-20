/**
 * `stitchkit/remote` — peer-free remote service implementation.
 *
 * `implementRemote` needs only the contract and HTTP client. Keeping it in its
 * own entrypoint lets CLI and other thin processes proxy a deployed API without
 * importing the MCP SDK or the AI SDK through the broad tools barrel.
 */
export { type ImplementRemoteOptions, implementRemote } from './tools/remote';
