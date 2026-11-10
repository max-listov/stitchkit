import assert from 'node:assert/strict';
import { z } from 'zod';

// The source regression supplies its entrypoints; installed proofs use only the public package.
const { createCli } = await import(process.argv[2] ?? 'stitchkit/cli');
const { AppError } = await import(process.argv[3] ?? 'stitchkit/contract');

const input = z.object({ refuse: z.boolean().optional() });
const output = z.unknown();
async function run(data, argv) {
  let out = '';
  let err = '';
  let code = -1;
  let calls = 0;
  await createCli({
    name: 'empty-lists',
    version: '1',
    runtimeTools: [
      {
        name: 'list',
        description: 'List synthetic records',
        identity: { serviceName: 'records', action: 'list', method: 'GET' },
        transports: ['CLI'],
        input,
        output,
        handler: ({ input }) => {
          calls++;
          if (input.refuse)
            throw new AppError('FORBIDDEN', { details: { message: 'Denied' } });
          return data;
        },
      },
    ],
    argv: ['list', ...argv],
    stdin: async () => null,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
  });
  return { out, err, code, calls };
}

const views = [
  { argv: ['--count-by', 'status'], expected: {} },
  { argv: ['--count-by', 'status', '--top', '2'], expected: {} },
  { argv: ['--top', '2', '--by', 'status'], expected: {} },
  { argv: ['--sum', 'amount'], expected: 0 },
  { argv: ['--sum', 'amount', '--by', 'status'], expected: {} },
  { argv: ['--sum', 'amount', '--by', 'status', '--top', '2'], expected: {} },
  { argv: ['--sort', 'amount'], expected: [] },
  { argv: ['--sort', 'amount', '--ascending', '--top', '2'], expected: [] },
  { argv: ['--count-by', 'nested.status'], expected: {} },
  { argv: ['--sum', 'nested.amount', '--by', 'nested.status'], expected: {} },
];
for (const data of [[], { items: [], total: 0 }]) {
  for (const json of [false, true]) {
    for (const { argv, expected } of views) {
      assert.deepEqual(await run(data, [...argv, ...(json ? ['--json'] : [])]), {
        out: `${JSON.stringify(expected, null, json ? undefined : 2)}\n`,
        err: '',
        code: 0,
        calls: 1,
      });
    }
  }
  for (const argv of [
    ['--table', 'status,amount'],
    ['--sort', 'amount', '--top', '2', '--table', 'status,amount'],
  ]) {
    assert.deepEqual(await run(data, argv), {
      out: 'status  amount\n------  ------\n',
      err: '',
      code: 0,
      calls: 1,
    });
  }
}

for (const path of ['', '.x', 'x.', 'x..y', '__proto__', 'x.__proto__.y']) {
  for (const argv of [
    ['--count-by', path],
    ['--sum', path],
    ['--sum', 'amount', '--by', path],
    ['--sort', path],
    ['--table', `status,${path || 'x..y'}`],
  ]) {
    const data = { items: [], total: 0 };
    const result = await run(data, argv);
    assert.equal(result.code, 8);
    assert.equal(result.calls, 1);
    // A read withholds its result: the corrected call returns it.
    assert.equal(result.out, '');
    assert.ok(
      JSON.parse(result.err).details.cause.details.message.includes(
        'not a readable field path',
      ),
    );
  }
}

const nonempty = {
  items: [
    { status: 'DONE', amount: 2 },
    { status: 'DONE', amount: 3 },
  ],
  total: 2,
};
for (const { argv, expected } of [
  { argv: ['--count-by', 'status'], expected: { DONE: 2 } },
  { argv: ['--sum', 'amount'], expected: 5 },
  { argv: ['--sum', 'amount', '--by', 'status'], expected: { DONE: 5 } },
]) {
  const result = await run(nonempty, argv);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.equal(result.calls, 1);
  assert.deepEqual(JSON.parse(result.out), expected);
}

function assertPresentationFailure(result) {
  assert.equal(result.code, 8);
  assert.equal(result.calls, 1);
  // The synthetic command is a GET: its answer is one corrected call away.
  assert.equal(result.out, '');
  const diagnostic = JSON.parse(result.err);
  assert.equal(diagnostic.error, 'CLI_PRESENTATION_FAILED');
  assert.equal(diagnostic.retryable, false);
  assert.equal(diagnostic.details.operationSucceeded, true);
  assert.equal(diagnostic.details.resultOnStdout, false);
  assert.equal(diagnostic.details.command, 'list');
  assert.ok(diagnostic._hint.includes('Repeat it with a corrected view'));
  return diagnostic.details.cause.details.message;
}
for (const ascending of [false, true]) {
  const data = [
    { id: 'null', n: null },
    { id: 'one', n: 1 },
    { id: 'absent' },
    { id: 'two', n: 2 },
  ];
  const result = await run(data, [
    '--sort',
    'n',
    ...(ascending ? ['--ascending'] : []),
    '--json',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.equal(result.calls, 1);
  assert.deepEqual(JSON.parse(result.out), [
    ...(ascending
      ? [
          { id: 'one', n: 1 },
          { id: 'two', n: 2 },
        ]
      : [
          { id: 'two', n: 2 },
          { id: 'one', n: 1 },
        ]),
    { id: 'null', n: null },
    { id: 'absent' },
  ]);
}
for (const field of ['toString', 'constructor', 'nested.toString', 'nested.constructor']) {
  const data = [{ amount: 2, nested: { status: 'DONE' } }];
  for (const argv of [
    ['--count-by', field],
    ['--sum', field],
    ['--sum', 'amount', '--by', field],
    ['--sort', field],
    ['--table', field],
  ]) {
    const result = await run(data, [...argv, '--json']);
    assert.ok(
      assertPresentationFailure(result).includes(`no record carries the field "${field}"`),
    );
  }
}
const own = [
  { toString: 'own', constructor: 'own', prototype: 'own', nested: { toString: 'own' } },
];
for (const field of ['toString', 'constructor', 'prototype', 'nested.toString']) {
  assert.deepEqual(await run(own, ['--count-by', field, '--json']), {
    out: '{"own":1}\n',
    err: '',
    code: 0,
    calls: 1,
  });
}
for (const argv of [
  ['--count-by', 'missing'],
  ['--sum', 'missing'],
  ['--sum', 'amount', '--by', 'missing'],
  ['--sort', 'missing'],
  ['--table', 'status,missing'],
]) {
  for (const json of [false, true]) {
    const result = await run(nonempty, [...argv, ...(json ? ['--json'] : [])]);
    const message = assertPresentationFailure(result);
    assert.ok(message.includes('no record carries the field "missing"'));
    assert.ok(message.includes('available: amount, status'));
  }
}
// Columns are asked of the collection: a cut that lacks a value is not an unknown field.
const sparse = [{ a: 1 }, { a: 2, b: 3 }];
assert.deepEqual(
  await run(sparse, ['--sort', 'a', '--ascending', '--top', '1', '--table', 'a,b']),
  {
    out: 'a  b\n-  -\n1\n',
    err: '',
    code: 0,
    calls: 1,
  },
);
assert.ok(
  assertPresentationFailure(
    await run(sparse, ['--sort', 'a', '--top', '1', '--table', 'a,missing', '--json']),
  ).includes('no record carries the field "missing"'),
);
// Largest first holds for keys a JSON object would otherwise sort, and markers stay distinct.
const years = [{ y: 2024 }, { y: 2025 }, { y: 2025 }, { y: 2023 }, { y: 2025 }, { y: 2024 }];
assert.equal(
  (await run(years, ['--count-by', 'y', '--top', '2', '--json'])).out,
  '{"2025":3,"2024":2}\n',
);
assert.equal(
  (await run(years, ['--count-by', 'y', '--top', '2'])).out,
  '{\n  "2025": 3,\n  "2024": 2\n}\n',
);
const markers = [{ v: null }, { v: 'null' }, { v: '(absent)' }, {}, { v: 1 }];
assert.deepEqual(JSON.parse((await run(markers, ['--count-by', 'v', '--json'])).out), {
  null: 1,
  '"null"': 1,
  '"(absent)"': 1,
  '(absent)': 1,
  1: 1,
});

// An empty collection answers for its records, not for fields of the object around it.
for (const [data, argv] of [
  [{ id: 1, amount: 100, warnings: [] }, ['--sum', 'amount']],
  [{ id: 1, amount: 100, warnings: [] }, ['--sum', 'id', '--by', 'amount']],
  [{ job: { status: 'x' }, warnings: [] }, ['--count-by', 'job.status']],
  [{ total: 0, items: [] }, ['--sort', 'total']],
]) {
  assert.ok(
    assertPresentationFailure(await run(data, argv)).includes('belongs to the result object'),
  );
}
for (const data of [null, 0, { total: 0 }, { items: [], other: [] }]) {
  const result = await run(data, ['--count-by', 'status']);
  assert.ok(assertPresentationFailure(result).includes('an aggregate needs'));
}

const refusal = await run({ items: [], total: 0 }, ['--refuse', '--count-by', 'status']);
assert.equal(refusal.code, 3);
assert.equal(refusal.calls, 1);
assert.equal(refusal.out, '');
assert.equal(JSON.parse(refusal.err).error, 'FORBIDDEN');
assert.ok(!refusal.err.includes('operationSucceeded'));
const invalid = await run([], ['--count-by', 'status', '--sum', 'amount']);
assert.equal(invalid.code, 2);
assert.equal(invalid.calls, 0);
assert.equal(invalid.out, '');
assert.ok(invalid.err.includes('different shapes'));
assert.deepEqual(await run({ items: [], total: 0 }, ['--json']), {
  out: '{"items":[],"total":0}\n',
  err: '',
  code: 0,
  calls: 1,
});
console.log('packed CLI empty aggregates: ok');
