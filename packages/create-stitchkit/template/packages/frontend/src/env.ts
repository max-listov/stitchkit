import path from 'node:path';
import { applicationVariables } from '@app/config/variables';
import { createEnv } from '@t3-oss/env-nextjs';
import { config } from 'dotenv';

config({ path: path.resolve(process.cwd(), '../../.env'), quiet: true });

/**
 * The web role's view of the environment — a PROJECTION of the one declaration
 * in `@app/config/variables`, never a second copy of it.
 *
 * There is deliberately NO `client` block. A `NEXT_PUBLIC_` variable is
 * substituted at BUILD time, so declaring one freezes a value of the place into
 * the artifact — the built server chunk once carried
 * `NEXT_PUBLIC_API_URL:"http://…"` as a literal while a plain `WEB_PORT` stayed
 * a runtime read. Anything the browser needs is either relative (so it needs no
 * address at all), derived from the request, or read on the server and handed
 * down per request — never compiled in.
 */
export const env = createEnv({
  server: {
    BIND_HOST: applicationVariables.BIND_HOST,
    WEB_PORT: applicationVariables.WEB_PORT,
    PUBLIC_WEB_ORIGIN: applicationVariables.PUBLIC_WEB_ORIGIN,
    PUBLIC_WEB_HOSTS: applicationVariables.PUBLIC_WEB_HOSTS,
    INTERNAL_API_URL: applicationVariables.INTERNAL_API_URL,
    PUBLIC_API_ORIGIN: applicationVariables.PUBLIC_API_ORIGIN,
    PUBLIC_REALTIME_ORIGIN: applicationVariables.PUBLIC_REALTIME_ORIGIN,
  },
  runtimeEnv: {
    BIND_HOST: process.env.BIND_HOST,
    WEB_PORT: process.env.WEB_PORT,
    PUBLIC_WEB_ORIGIN: process.env.PUBLIC_WEB_ORIGIN,
    PUBLIC_WEB_HOSTS: process.env.PUBLIC_WEB_HOSTS,
    INTERNAL_API_URL: process.env.INTERNAL_API_URL,
    PUBLIC_API_ORIGIN: process.env.PUBLIC_API_ORIGIN,
    PUBLIC_REALTIME_ORIGIN: process.env.PUBLIC_REALTIME_ORIGIN,
  },
  emptyStringAsUndefined: true,
});
