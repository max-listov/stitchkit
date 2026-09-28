/** Receipt/storage/audit refusals belong to the runtime, never to the upstream provider. */
export class InvocationReceiptError extends Error {
  constructor(cause: unknown) {
    super('Model invocation receipt could not be recorded', { cause });
    this.name = 'InvocationReceiptError';
  }
}
export async function invocationAudit<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof InvocationReceiptError ? error : new InvocationReceiptError(error);
  }
}
