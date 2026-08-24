import { createApplication } from 'stitchkit/application';
import { bindProcessSignals } from 'stitchkit/server';

const application = createApplication({ id: 'packed-node-signal' });
await application.start();
const forceMode = process.argv[2] === 'forced';
let forceKeepAlive;
const admitted = application.admission.run(() =>
  forceMode
    ? new Promise((resolve) => {
        forceKeepAlive = setTimeout(resolve, 10_000);
      })
    : new Promise((resolve) => setTimeout(resolve, 40)),
);
const binding = bindProcessSignals(application, {
  shutdown: { gracePeriodMs: forceMode ? 10 : 1_000, forceTimeoutMs: 100 },
});
console.log('APPLICATION_READY');
const result = await binding.promise;
if (forceMode) clearTimeout(forceKeepAlive);
else await admitted;
console.log(`APPLICATION_RESULT ${JSON.stringify(result)}`);
