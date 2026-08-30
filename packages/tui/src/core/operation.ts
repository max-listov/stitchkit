import { z } from 'zod';

export const TerminalOperationStateSchema = z
  .object({
    status: z.enum(['idle', 'confirming', 'pending', 'succeeded', 'failed']),
    operationId: z.string().min(1).nullable(),
    message: z.string().optional(),
  })
  .strict();

export type TerminalOperationState = z.infer<typeof TerminalOperationStateSchema>;

export type TerminalOperationAction =
  | { type: 'request'; operationId: string; message?: string }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'succeed'; message?: string }
  | { type: 'fail'; message: string }
  | { type: 'reset' };

export function createTerminalOperationState(): TerminalOperationState {
  return { status: 'idle', operationId: null };
}
export function reduceTerminalOperationState(
  state: TerminalOperationState,
  action: TerminalOperationAction,
): TerminalOperationState {
  const current = TerminalOperationStateSchema.parse(state);
  if (action.type === 'request') {
    if (current.status === 'pending')
      throw new Error('A terminal operation is already pending');
    return TerminalOperationStateSchema.parse({
      status: 'confirming',
      operationId: action.operationId,
      ...(action.message !== undefined && { message: action.message }),
    });
  }
  if (action.type === 'reset' || action.type === 'cancel') {
    if (action.type === 'cancel' && current.status !== 'confirming') {
      throw new Error('Only a confirming terminal operation can be cancelled');
    }
    return createTerminalOperationState();
  }
  if (action.type === 'confirm') {
    if (current.status !== 'confirming') {
      throw new Error('Only a confirming terminal operation can become pending');
    }
    return { ...current, status: 'pending' };
  }
  if (current.status !== 'pending') {
    throw new Error('Only a pending terminal operation can settle');
  }
  return TerminalOperationStateSchema.parse({
    status: action.type === 'succeed' ? 'succeeded' : 'failed',
    operationId: current.operationId,
    ...(action.message !== undefined && { message: action.message }),
  });
}
