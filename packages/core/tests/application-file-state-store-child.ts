import { access, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createFileStateStore } from '../src/application/file-state-store';

const [path, ready, proceed] = process.argv.slice(2);
if (!path || !ready || !proceed) throw new Error('Expected state, ready and proceed paths');
const store = createFileStateStore(path, { schema: z.object({ counter: z.int() }).strict() });
await store.update(async (current) => {
  await writeFile(ready, 'held');
  for (;;) {
    try {
      await access(proceed);
      break;
    } catch {
      await Bun.sleep(5);
    }
  }
  return { state: { counter: (current?.counter ?? 0) + 1 }, result: undefined };
});
