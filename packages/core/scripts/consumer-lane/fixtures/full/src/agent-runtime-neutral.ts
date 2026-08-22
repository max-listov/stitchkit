import { createMemoryAgentRuntimeStore } from 'stitchkit/agent-runtime';

const store = createMemoryAgentRuntimeStore();
const snapshot = await store.loadSnapshot('neutral-runtime-bundle');
if (snapshot.version !== 0) throw new Error('neutral runtime store failed');
