import { type ExclusiveLockOptions, writeFileAtomic } from 'neutral-library-fixture/files';
import { canonicalJson } from 'neutral-library-fixture/primitives';
import {
  observeProcessInstance,
  type ProcessOwnerEvidence,
} from 'neutral-library-fixture/process';

const lock: ExclusiveLockOptions = { ownerlessGraceMs: null };
void lock;
void writeFileAtomic('x', canonicalJson({ a: 1 }));
void observeProcessInstance(1).then((observation) => {
  if (observation.state === 'unavailable') void observation.cause;
});
const evidence: ProcessOwnerEvidence = {
  identity: 'unavailable',
  liveness: 'not-probed',
  cause: new Error(),
};
void evidence;
