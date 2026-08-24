import {
  createActivityProjection,
  createApplication,
  createManagedSchedule,
} from 'stitchkit/application';

const activity = createActivityProjection({ id: 'neutral', stages: ['running'] });
const app = createApplication({
  id: 'neutral',
  resources: [createManagedSchedule({ id: 'tick', everyMs: 60_000, run: () => undefined })],
});
await app.start();
const token = activity.open('running');
activity.complete(token);
await app.shutdown();
console.log('neutral application bundle ok');
