// Preflight for `start` / `pm2:prod`: a missing build otherwise surfaces as a
// bare `Module not found "dist/index.js"` with no hint at the obvious fix.
const entry = new URL('../dist/index.js', import.meta.url);
if (!(await Bun.file(entry).exists())) {
  console.error('dist/index.js not found — run `bun run build` first.');
  process.exit(1);
}
