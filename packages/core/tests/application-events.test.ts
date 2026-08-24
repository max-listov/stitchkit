import { expect, test } from 'bun:test';
import {
  applicationLifecycleEvent,
  createApplicationEventSink,
} from '../src/application/events';
import { createApplication } from '../src/application/kernel';

test('application lifecycle events are sanitized and sink failures stay isolated', async () => {
  const seen: number[] = [];
  const failures: unknown[] = [];
  const sink = createApplicationEventSink({
    write(event) {
      seen.push(event.revision);
      if (seen.length === 1) throw new Error('observer unavailable');
    },
    onSinkError: ({ error }) => void failures.push(error),
  });
  const app = createApplication({
    id: 'events',
    onSnapshot: (snapshot) => sink.publish(snapshot),
  });
  await app.start();
  await app.shutdown();
  await sink.close();

  expect(seen.length).toBeGreaterThan(1);
  expect(failures).toHaveLength(1);
  const event = applicationLifecycleEvent(app.getSnapshot());
  expect(Object.keys(event).sort()).toEqual([
    'applicationId',
    'capturedAt',
    'epoch',
    'health',
    'lifecycle',
    'ready',
    'resources',
    'revision',
    'type',
  ]);
  expect(JSON.stringify(event)).not.toContain('acceptedOperations');
});
