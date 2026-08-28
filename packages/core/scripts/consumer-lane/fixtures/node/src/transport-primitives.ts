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
      stream: { item: z.object({ value: z.number() }) },
    },
  },
);
implement(contract, {
  read: async function* () {
    yield { value: 1 };
  },
});
const client = createClient(contract, { baseUrl: 'http://local' });
const iterator: Promise<AsyncIterableIterator<{ value: number }>> = client.read();
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
