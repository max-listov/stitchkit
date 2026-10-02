import { NativeCommandError } from 'stitchkit/process';

function classify(error: unknown): 'timeout' | 'overflow' | undefined {
  if (!(error instanceof NativeCommandError) || error.code !== 'COMMAND_LIMIT') return;
  switch (error.reason) {
    case 'deadline':
      return 'timeout';
    case 'output-budget':
      return 'overflow';
    case undefined:
      return;
    default: {
      const exhaustive: never = error.reason;
      return exhaustive;
    }
  }
}

function existingConstructor(code: NativeCommandError['code'], options: ErrorOptions) {
  return new NativeCommandError(code, 'caller wording', options);
}

const deadline = new NativeCommandError('COMMAND_LIMIT', 'localized wording', {
  cause: new Error('cause'),
  reason: 'deadline',
});
const budget = new NativeCommandError('COMMAND_LIMIT', 'localized wording', {
  reason: 'output-budget',
});
// @ts-expect-error machine evidence is a closed vocabulary
new NativeCommandError('COMMAND_LIMIT', 'invalid', { reason: 'memory' });
// @ts-expect-error cleanup is not a command limit
new NativeCommandError('COMMAND_CLEANUP', 'invalid', { reason: 'deadline' });
// @ts-expect-error unavailable commands carry no limit reason
new NativeCommandError('COMMAND_UNAVAILABLE', 'invalid', { reason: 'output-budget' });

void classify(deadline);
void classify(budget);
void existingConstructor;
