import { z } from 'zod';
import { defineContract } from '../../src/contract';
import { implement } from '../../src/server';

const ParamsSchema = z.object({ id: z.string().min(2) });
const InputSchema = z.object({ name: z.string() });
const OutputSchema = z.object({ ok: z.boolean() });
export const groupErrorContract = defineContract(
  { prefix: 'items' },
  {
    save: {
      method: 'POST',
      path: '/:id',
      desc: 'Save item',
      params: ParamsSchema,
      input: InputSchema,
      output: OutputSchema,
    },
  },
);
export const groupErrorService = implement(groupErrorContract, { save: () => ({ ok: true }) });
export function groupErrorRequest(id = 'abc', body: unknown = { name: 'item' }) {
  return new Request(`http://localhost/group/items/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
