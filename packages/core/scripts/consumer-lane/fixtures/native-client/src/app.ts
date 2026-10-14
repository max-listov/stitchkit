import { createQueryClientFactory } from 'stitchkit/react';
import { createRetainedTopics } from 'stitchkit/realtime';

const queryClient = createQueryClientFactory({ server: () => false })();
const retained = createRetainedTopics<{ greeting: string }>();

queryClient.setQueryData(['native', 'greeting'], { message: 'cached' });
if (
  queryClient.getQueryData<{ message: string }>(['native', 'greeting'])?.message !== 'cached'
)
  throw new Error('native query cache lost the typed value');
retained.record('greeting', 'sticky');
let received: unknown;
retained.replay('greeting', (value: unknown) => {
  received = value;
});
if (received !== 'sticky') throw new Error('native retained replay lost the value');
queryClient.clear();
console.log('native client query and retained state: ok');
