/**
 * Declarative click tracking. An element marked `data-track="name"` records a
 * click; `data-track-action="name"` records an interaction (with an optional
 * `data-track-context`); a link to another origin records an outbound click.
 * The attribute names are the application's to choose.
 */

/** What the resolver needs from a click target — `Element` satisfies it. */
export interface ClickTarget {
  closest(selector: string): ClickTarget | null;
  getAttribute(name: string): string | null;
  textContent: string | null;
}

export interface TrackedClickAttributes {
  /** Default `data-track`. */
  track?: string;
  /** Default `data-track-action`. */
  action?: string;
  /** Default `data-track-context`. */
  context?: string;
}

export interface ResolveTrackedClickOptions {
  /** `location.origin` — decides same-origin navigation versus outbound. */
  origin: string;
  attributes?: TrackedClickAttributes;
  /** Whether an action name is one the application knows. Default: any. */
  isAction?: (action: string) => boolean;
}

export interface TrackedClick {
  interaction?: { action: string; context?: string };
  click?: { element: string; elementText?: string; href?: string };
  outbound?: { href: string; label?: string };
  /** The click navigates away — send its facts on the unload path. */
  leavesPage: boolean;
}

function label(target: ClickTarget | null): string | undefined {
  return (target?.textContent ?? '').trim().slice(0, 100) || undefined;
}

function sanitizedHref(value: string | null, origin: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.pathname : `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function resolveTrackedClick(
  target: ClickTarget | null,
  { origin, attributes = {}, isAction = () => true }: ResolveTrackedClickOptions,
): TrackedClick | null {
  if (!target) return null;
  const trackAttribute = attributes.track ?? 'data-track';
  const actionAttribute = attributes.action ?? 'data-track-action';
  const contextAttribute = attributes.context ?? 'data-track-context';
  const tracked = target.closest(`[${trackAttribute}], [${actionAttribute}]`);
  const anchor = target.closest('a[href]');
  const href = anchor?.getAttribute('href') ?? tracked?.getAttribute('href') ?? null;

  let sameOriginNavigation = false;
  let outbound = false;
  if (href) {
    try {
      const url = new URL(href, origin);
      sameOriginNavigation = url.origin === origin;
      outbound = url.protocol.startsWith('http') && !sameOriginNavigation;
    } catch {
      sameOriginNavigation = false;
    }
  }

  const result: TrackedClick = { leavesPage: sameOriginNavigation || outbound };
  if (tracked) {
    const action = tracked.getAttribute(actionAttribute);
    const element = tracked.getAttribute(trackAttribute);
    if (action && isAction(action)) {
      result.interaction = {
        action,
        context: tracked.getAttribute(contextAttribute) ?? undefined,
      };
    } else if (element) {
      result.click = {
        element,
        elementText: label(tracked),
        href: sanitizedHref(href, origin),
      };
    }
  }
  if (outbound && href) {
    result.outbound = { href: sanitizedHref(href, origin) ?? href, label: label(anchor) };
  }
  return result.interaction || result.click || result.outbound ? result : null;
}
