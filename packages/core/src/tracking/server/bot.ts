/**
 * Crawlers and monitors are not visitors. The pattern is the one two
 * consuming applications converged on; it includes `headlesschrome`, so an
 * agent's browser is a bot too — probe with a real user agent, set at browser
 * launch (a context override does not reach `sendBeacon`).
 */
export const DEFAULT_BOT_USER_AGENT_PATTERN =
  /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|bingpreview|yandex|baidu|duckduckbot|uptimerobot|pingdom|gtmetrix|pagespeed|lighthouse|headlesschrome/i;

export function isBotUserAgent(
  userAgent: string | null | undefined,
  pattern: RegExp = DEFAULT_BOT_USER_AGENT_PATTERN,
): boolean {
  return userAgent ? pattern.test(userAgent) : false;
}
