// The kernel refuses the group SIGKILL: the tool reports a safe error and the internal cause stays retained.
import assert from 'node:assert/strict';

const [root, entry, mount] = process.argv.slice(2);
const { createAgentCodingTools } = await import(entry);
const { mountAgent } = await import(mount);
const original = process.kill;
const refusal = Object.assign(new Error('group-refusal-marker'), { code: 'EPERM' });
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGKILL') throw refusal;
  return original(pid, signal);
};
const definitions = createAgentCodingTools({
  root,
  authorize: () => true,
  executables: { printf: '/usr/bin/printf' },
  limits: { shellTerminationGraceMs: 20, shellTimeoutMs: 200 },
});
const definition = definitions.find((tool) => tool.name === 'run_command');
const hasCause = (error) =>
  error === refusal ||
  (error instanceof AggregateError && error.errors.some(hasCause)) ||
  (error instanceof Error && hasCause(error.cause));
try {
  await definition.handler({
    params: undefined,
    input: { executable: 'printf', args: ['ok'], cwd: '.' },
  });
  throw new Error('Unexpected successful cleanup');
} catch (error) {
  assert.equal(error.code, 'COMMAND_CLEANUP');
  assert.equal(hasCause(error), true);
}
const errors = [];
console.error = (...values) => errors.push(values.map(String).join(' '));
const execute = mountAgent([], { runtimeTools: definitions }).run_command.execute;
try {
  await execute(
    { executable: 'printf', args: ['ok'] },
    { toolCallId: 'refusal', messages: [], context: undefined },
  );
  throw new Error('Unexpected successful tool');
} catch (error) {
  assert.equal(error.output.error, 'INTERNAL_SERVER_ERROR');
  assert.equal(JSON.stringify(error.output).includes('group-refusal-marker'), false);
}
process.kill = original;
console.log('coding group cleanup refusal: ok');
