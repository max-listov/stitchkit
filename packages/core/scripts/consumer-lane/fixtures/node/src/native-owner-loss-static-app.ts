import { runNativeCommand } from 'stitchkit/process';

// Static-import control: the original package entry keeps handling its own guard invocation.
if (process.argv[2] === 'probe') {
  const result = await runNativeCommand({
    executable: '/bin/echo',
    args: ['static-owner-loss'],
    ownerLoss: 'terminate',
    timeoutMs: 2000,
    capture: true,
    maxOutputBytes: 4096,
  });
  if (
    result.exitCode !== 0 ||
    new TextDecoder().decode(result.stdout).trim() !== 'static-owner-loss'
  )
    throw new Error('static owner-loss probe returned the wrong result');
  console.log('static owner-loss probe: ok');
}
