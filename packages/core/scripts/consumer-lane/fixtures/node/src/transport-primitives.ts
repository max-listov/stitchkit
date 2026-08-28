import { createClient } from 'stitchkit';
import {
  type BoundedAdmissionResult,
  type BoundedChannelOfferResult,
  createBoundedAdmission,
  createBoundedChannel,
  createCreditWindow,
} from 'stitchkit/application';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/node';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'typed-node-stream' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'Compile a typed Node stream',
      stream: {
        item: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('value'), value: z.number() }),
          z.object({ kind: z.literal('complete') }),
        ]),
        framing: 'item',
        completion: 'terminal',
        terminal: z.object({ kind: z.literal('complete') }),
        finalLine: 'require-newline',
      },
    },
  },
);
implement(contract, {
  read: async function* () {
    yield { kind: 'value', value: 1 };
    yield { kind: 'complete' };
  },
});
const client = createClient(contract, { baseUrl: 'http://local' });
const iterator: Promise<
  AsyncIterableIterator<z.output<(typeof contract.endpoints.read.stream)['item']>>
> = client.read();
void iterator;

const admission = createBoundedAdmission({ policy: { global: { maxConcurrent: 1 } } });
const admissionResult: BoundedAdmissionResult = admission.acquire();
void admissionResult;
const channel = createBoundedChannel<number>({
  policy: 'ordered',
  maxItems: 1,
  maxBytes: 1,
  sizeOf: () => 1,
});
const offered: BoundedChannelOfferResult = channel.offer(1);
void offered;
createCreditWindow({ capacityBytes: 1 });
