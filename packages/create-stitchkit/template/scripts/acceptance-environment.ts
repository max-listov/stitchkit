/**
 * The environment of a local acceptance run: the deployment's own variables,
 * with every address in them replaced by this run's.
 *
 * The roles start on ephemeral ports, so an address copied from `.env` names a
 * port this run does not own — and on a machine where another process listens
 * there, the browser under test talks to that process and the gate passes or
 * fails for someone else's reasons.
 */
export interface AcceptanceAddresses {
  readonly apiPort: number;
  readonly webPort: number;
  readonly home: string;
  readonly databaseUrl: string;
}

export function acceptanceEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  { apiPort, webPort, home, databaseUrl }: AcceptanceAddresses,
): Record<string, string> {
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) environment[name] = value;
  }
  delete environment.ACCEPTANCE_DATABASE_URL;
  return Object.assign(environment, {
    NODE_ENV: 'production',
    // The gates read the catalogue and the OpenAPI document; the closed default is
    // proved after them, on the same artifact.
    SERVICE_SURFACES: 'open',
    // The one address every role, every migration and every gate here will see.
    DATABASE_URL: databaseUrl,
    PM2_HOME: home,
    API_PORT: String(apiPort),
    WEB_PORT: String(webPort),
    INTERNAL_API_URL: apiOrigin,
    SMOKE_API_ORIGIN: apiOrigin,
    SMOKE_WEB_ORIGIN: webOrigin,
    PLAYWRIGHT_BASE_URL: webOrigin,
    // Two roles on two loopback ports: the browser dials the socket on the API
    // role directly, and the API role admits the web role's origin.
    PUBLIC_REALTIME_ORIGIN: apiOrigin,
    CORS_ORIGIN: webOrigin,
    // The portability proof asks this deployment to answer as addresses other
    // than the one it is dialled on. Those addresses belong to the CHECK, so
    // they are supplied here rather than written into the project's own
    // `.env.example`, where they would be policy a deployment carries for real.
    PUBLIC_WEB_HOSTS: `127.0.0.1:${webPort},alpha.example,beta.example:8443`,
  });
}
