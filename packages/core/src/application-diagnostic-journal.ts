/**
 * The local diagnostic journal — the one part of the application kernel that
 * touches the machine.
 *
 * Its own entrypoint because of what it reaches: `node:child_process`,
 * `node:fs`, `node:os` and `node:util`, with `promisify(execFile)` evaluated
 * while the module initialises. Exported from `stitchkit/application`, that one
 * line made the entire barrel — the kernel, admission, schedules, keyspaces and
 * every application schema, 208 names — unusable in a browser bundle, and not
 * by failing at the call: a bundler substitutes stubs for Node built-ins, so the
 * page died during module initialisation, on every route.
 *
 * Its *contract* — every `DiagnosticJournal*Schema`, the states, the refusal
 * reasons — stays in `stitchkit/application`, because none of it touches the
 * machine and a client reading a journal's status has as much right to those
 * schemas as the server writing them.
 *
 * → ADR 0156.
 */
export { createDiagnosticJournal } from './application/diagnostic-journal';
