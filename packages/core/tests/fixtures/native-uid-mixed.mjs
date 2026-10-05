// Mixed-UID proof: Node from PATH, an outsider refused with EACCES and a SIGKILL reclaim.
const [helper, files] = process.argv.slice(2);
const { verifySharedUID } = await import(helper);
await verifySharedUID(files);
console.log('native mixed UID: ok');
