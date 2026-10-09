export {};

if (process.argv[2] === 'probe') {
  const marker = process.argv[3];
  if (marker === undefined) throw new Error('negative-control marker is required');
  const { runNativeCommand } = await import('stitchkit/process');
  try {
    await runNativeCommand({
      executable: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      ownerLoss: 'terminate',
      timeoutMs: 2000,
    });
    throw new Error('lazy bundle without bootstrap unexpectedly started its target');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code !== 'COMMAND_UNAVAILABLE') throw error;
    console.error(code);
    process.exitCode = 23;
  }
} else {
  console.error('unknown application command');
  process.exitCode = 64;
}
