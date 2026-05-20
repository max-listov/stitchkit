// Client logger — plain text, shown in terminal via Bun's console: true

const icons = {
  fetch: '->',
  fetched: 'ok',
  cached: '.',
  dedup: '=',
  refetch: '<-',
  invalidate: 'x',
  skip: '.',
  error: '!',
  mutation: '^',
};

export const log = {
  query: (key: string, action: string, detail?: string) =>
    console.log(
      `  ${icons[action as keyof typeof icons] ?? '.'} ${key} ${action}${detail ? ` (${detail})` : ''}`,
    ),
  fetched: (key: string, ms: number) =>
    console.log(`  ${icons.fetched} ${key} ${Math.round(ms)}ms`),
  cached: (key: string) => console.log(`  ${icons.cached} ${key} cached`),
  invalidate: (key: string) => console.log(`  ${icons.invalidate} ${key} invalidated`),
  skip: (key: string) => console.log(`  ${icons.skip} ${key} skip (fresh)`),
  error: (key: string, msg: string) => console.error(`  ${icons.error} ${key} ${msg}`),
  mutation: (key: string, action: string) =>
    console.log(`  ${icons.mutation} ${key} ${action}`),
};
