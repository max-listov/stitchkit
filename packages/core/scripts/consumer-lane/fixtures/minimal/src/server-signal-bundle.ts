import { bindProcessSignals, type ShutdownTarget } from 'stitchkit/server';

const target: ShutdownTarget<{ outcome: 'clean' }> = {
  shutdown: async () => ({ outcome: 'clean' }),
};

const binding = bindProcessSignals(target, { signals: [] });
binding.close();
console.log('peer-free server signal bundle ok');
