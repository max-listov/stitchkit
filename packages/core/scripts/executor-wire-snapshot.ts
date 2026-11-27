/**
 * Write the wire schemas of the executor ↔ server contract, as one release declared them, to a
 * JSON file — the snapshot `tests/agent-executor/wire-version-skew.test.ts` parses today's
 * messages with.
 *
 *   git archive vX.Y.Z packages/core/src | tar -x -C <dir>
 *   bun packages/core/scripts/executor-wire-snapshot.ts <dir>/packages/core/src \
 *     packages/core/tests/fixtures/executor-wire/X.Y.Z.json
 *
 * The extracted tree needs `zod` resolvable (a `node_modules` link beside it is enough).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const [sourceRoot, target] = process.argv.slice(2);
if (sourceRoot === undefined || target === undefined) {
  throw new Error('Usage: executor-wire-snapshot.ts <release src directory> <output.json>');
}

const SchemaModule = z.record(z.string(), z.unknown());
const load = async (file: string) =>
  SchemaModule.parse(await import(resolve(sourceRoot, 'agent-executor', file)));
const contract = await load('executor-contract.ts');
const hello = await load('hello.ts');

/** Every message of the contract, by the direction it travels. */
const MESSAGES = {
  'executor→server': {
    hello: hello.ExecutorHelloSchema,
    claim: contract.ThreadClaimSchema,
    renew: contract.ThreadRenewSchema,
    report: contract.TurnReportSchema,
  },
  'server→executor': {
    helloAck: hello.ExecutorHelloAckSchema,
    lease: contract.ThreadLeaseSchema,
    reportAck: contract.TurnReportAckSchema,
    offer: contract.TurnOfferSchema,
    interrupt: contract.TurnInterruptSchema,
    reply: contract.InteractionReplySchema,
  },
};

const snapshot = Object.fromEntries(
  Object.entries(MESSAGES).map(([direction, schemas]) => [
    direction,
    Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => {
        if (!(schema instanceof z.ZodType)) {
          throw new Error(`${name} is not a schema in ${sourceRoot}`);
        }
        // `input`: what a sender may write. `any`: a value JSON Schema cannot say stays open.
        return [name, z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })];
      }),
    ),
  ]),
);
writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
// The repository's formatter owns the layout of committed JSON; `lint` refuses any other.
const formatted = Bun.spawnSync(['bunx', 'biome', 'format', '--write', target], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if (formatted.exitCode !== 0)
  throw new Error(`biome format exited with ${formatted.exitCode}`);
