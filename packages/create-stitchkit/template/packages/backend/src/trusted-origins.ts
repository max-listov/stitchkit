/**
 * The browser origins a fenced API role admits, all of them already declared.
 *
 * A browser on the web role's own address reaches this role through the `/api`
 * forwarding, so its request arrives with that address as `Origin` and the
 * internal one as `Host`. Those disagree by construction, and only the public
 * hosts the deployment claims can tell it from a forged page.
 */
export function trustedBrowserAuthorities(env: {
  CORS_ORIGIN?: string | undefined;
  PUBLIC_WEB_ORIGIN?: string | undefined;
  PUBLIC_WEB_HOSTS?: string | undefined;
}): string[] {
  const authorities = [
    ...[env.CORS_ORIGIN, env.PUBLIC_WEB_ORIGIN].flatMap((origin) =>
      origin ? [new URL(origin).host] : [],
    ),
    ...(env.PUBLIC_WEB_HOSTS ?? '').split(',').map((host) => host.trim()),
  ];
  return [...new Set(authorities.filter((host) => host !== ''))];
}
