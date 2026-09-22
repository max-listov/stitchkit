/**
 * Guard: `stitchkit/tools` must not pull the agent RUNTIME into its bundle
 * graph — the store, the run protocol, the runtime factory.
 *
 * The durability ENGINE is allowed there on purpose: it is self-contained and
 * exported from `stitchkit/tools` so an application running its own agent loop
 * gets restartable tool bodies without adopting `agent-runtime`. What must never
 * follow it is the runtime proper, and that promise lives entirely in the built
 * artifact: no source-level test can hold it, because the type imports involved
 * erase at compile time and an import test is green either way. Only the real
 * chunk graph answers.
 *
 * It scans the built dist for the same reason `check-browser-clean` does — the
 * leak that matters is a bundler `--splitting` effect, invisible upstream.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dist = join(dirname(new URL(import.meta.url).pathname), '../dist');

/** Every chunk reachable from one entry, following relative imports. */
function graphOf(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = readFileSync(join(dist, file), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:from|import)\s*"\.\/([^"]+)"/g)) {
      queue.push(match[1]);
    }
  }
  return seen;
}

// Names that exist only inside the runtime proper — never in the durability
// engine. Chosen over the module path because the bundler renames chunks on
// every build.
const RUNTIME_ONLY = [
  'createAgentRuntime',
  'createAgentRuntimeStore',
  'createAgentRuntimeEventSink',
];

const graph = graphOf('tools.js');
const offenders = [];
for (const marker of RUNTIME_ONLY) {
  for (const file of graph) {
    let source;
    try {
      source = readFileSync(join(dist, file), 'utf8');
    } catch {
      continue;
    }
    if (source.includes(marker)) offenders.push(`${file} carries ${marker}`);
  }
}

if (offenders.length > 0) {
  console.error(
    '[check-durability-port-standalone] stitchkit/tools pulled the agent runtime proper:',
  );
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(
    '\n  The durability engine may live in the tools graph; the runtime, the store and\n' +
      '  the run protocol may not. Check what the tools barrel imports from agent-runtime.',
  );
  process.exit(1);
}

console.log(
  `[check-durability-port-standalone] tools graph (${graph.size} chunks) carries the durability engine and no runtime`,
);
