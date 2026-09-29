/**
 * A screen's address: a path whose `:name` segments are its params.
 *
 * The path is the whole navigation model. A screen's parent is the nearest
 * declared screen whose path is a prefix of its own, segment by segment, so
 * "back" is a fact about the tree rather than a history someone has to keep —
 * nothing to lose on a restart, nothing to corrupt when a press arrives from an
 * older message.
 */

import { type PathParams, parseRoutePattern } from '../../internal/route-pattern';
import { argumentsDigest } from '../../internal/stable-digest';

/** The params a screen path names, as strings (`/bot/:botId` → `{ botId: string }`). */
export type ScreenPathParams<TPath extends string> = PathParams<TPath>;

export interface ScreenPath {
  readonly path: string;
  readonly segments: readonly string[];
  /** Param names in path order — the order a button carries them in. */
  readonly params: readonly string[];
}

export function parseScreenPath(path: string): ScreenPath {
  if (!path.startsWith('/')) {
    throw new Error(`[stitchkit] telegram screens: path "${path}" must start with "/".`);
  }
  const parameters = parseRoutePattern(path);
  const wildcard = parameters.find((parameter) => parameter.kind === 'wildcard');
  if (wildcard) {
    throw new Error(
      `[stitchkit] telegram screens: path "${path}" may not end in a wildcard ("*${wildcard.name}").`,
    );
  }
  return {
    path,
    segments: path.split('/').filter(Boolean),
    params: parameters.map((parameter) => parameter.name),
  };
}

/** `parent` is a strict prefix of `child`, segment by segment. */
export function isAncestorPath(parent: ScreenPath, child: ScreenPath): boolean {
  if (parent.segments.length >= child.segments.length) return false;
  return parent.segments.every((segment, index) => child.segments[index] === segment);
}

/**
 * A short id derived from the path: stable across releases while the path is,
 * and short enough to leave a button room for its params.
 */
export function derivedScreenId(path: string): string {
  return argumentsDigest({ screen: path }).slice(0, 6);
}

/** The concrete chat-facing path, for logs and transitions. */
export function formatScreenPath(
  path: ScreenPath,
  params: Readonly<Record<string, string>>,
): string {
  return `/${path.segments
    .map((segment) =>
      segment.startsWith(':') ? (params[segment.slice(1)] ?? segment) : segment,
    )
    .join('/')}`;
}
