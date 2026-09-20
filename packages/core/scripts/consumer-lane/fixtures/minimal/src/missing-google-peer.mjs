// The Google adapter is the only entrypoint that owns this optional peer.
// Importing it without opting in must fail with the exact missing package.
await import('stitchkit/google');
