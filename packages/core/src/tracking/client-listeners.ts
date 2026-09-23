/**
 * Everything a started tracking client listens to on its host: coming back
 * online, leaving the page, hiding and returning, the heartbeat, scroll depth
 * and declarative clicks. Each subscription returns its own `off`.
 */

import { resolveTrackedClick } from './clicks';
import type { BuiltinTrackingEventTypes, Draft } from './client';
import type { TrackingHost } from './host';
import type { createScrollMilestones } from './scroll';
import type { createVisibleTimeMeter } from './visible-time';

export interface TrackingListenerDeps<TType extends string> {
  readonly host: TrackingHost;
  readonly builtin: BuiltinTrackingEventTypes<TType>;
  readonly heartbeatMs: number;
  readonly renewAfterHiddenMs: number;
  readonly meter: ReturnType<typeof createVisibleTimeMeter>;
  readonly scroll: ReturnType<typeof createScrollMilestones>;
  draft(type: TType, metadata?: Record<string, unknown>): Draft<TType>;
  leaveDraft(page: string): Draft<TType>;
  send(drafts: Draft<TType>[]): void;
  sendOnUnload(draft: Draft<TType>): void;
  flushOutbox(): Promise<void>;
  renewVisit(): Promise<unknown>;
  currentPage(): string;
  releaseLease(): void;
  readonly clickAttributes: Parameters<typeof resolveTrackedClick>[1]['attributes'];
  readonly isAction: Parameters<typeof resolveTrackedClick>[1]['isAction'];
}

export function wireTrackingListeners<TType extends string>(
  deps: TrackingListenerDeps<TType>,
): Array<() => void> {
  const { host, builtin } = deps;
  const unsubscribe: Array<() => void> = [];
  const renewThenFlush = () => void deps.renewVisit().then(() => deps.flushOutbox());
  unsubscribe.push(host.on('online', renewThenFlush));
  unsubscribe.push(host.interval(() => void deps.flushOutbox(), deps.heartbeatMs));

  // `pagehide` and `visibilitychange:hidden` arrive as a pair a millisecond
  // apart when leaving for another document; the second is the same fact.
  let hiddenAt: number | null = null;
  let lastLeaveAt = Number.NEGATIVE_INFINITY;
  const onHide = () => {
    const at = host.now();
    if (at - lastLeaveAt < 1_000) return;
    lastLeaveAt = at;
    deps.sendOnUnload(deps.leaveDraft(deps.currentPage()));
    deps.releaseLease();
  };
  unsubscribe.push(host.on('pagehide', onHide));
  unsubscribe.push(
    host.on('visibilitychange', () => {
      if (!host.visible()) {
        hiddenAt = host.wallClock();
        onHide();
        return;
      }
      deps.meter.checkpoint();
      if (hiddenAt !== null && host.wallClock() - hiddenAt >= deps.renewAfterHiddenMs) {
        renewThenFlush();
      }
      hiddenAt = null;
    }),
  );

  // Heartbeat: proof of presence and the next cut of visible time.
  unsubscribe.push(
    host.interval(() => {
      deps.send([deps.draft(builtin.heartbeat, { ...deps.meter.heartbeat(host.visible()) })]);
    }, deps.heartbeatMs),
  );

  // Scroll: the deepest point, checked every two seconds, milestones once each.
  unsubscribe.push(host.on('scroll', () => deps.scroll.record(host.scrollDepth())));
  unsubscribe.push(
    host.interval(() => {
      for (const milestone of deps.scroll.observe(host.scrollDepth())) {
        deps.send([deps.draft(builtin.scrollDepth, { maxPercent: milestone })]);
      }
    }, 2_000),
  );

  unsubscribe.push(
    host.onClick((target) => {
      const click = resolveTrackedClick(target, {
        origin: host.page().origin,
        attributes: deps.clickAttributes,
        isAction: deps.isAction,
      });
      if (!click) return;
      const drafts: Draft<TType>[] = [];
      if (click.interaction)
        drafts.push(deps.draft(builtin.interaction, { ...click.interaction }));
      if (click.click) drafts.push(deps.draft(builtin.click, { ...click.click }));
      if (click.outbound)
        drafts.push(deps.draft(builtin.outboundClick, { ...click.outbound }));
      if (click.leavesPage) for (const item of drafts) deps.sendOnUnload(item);
      else deps.send(drafts);
    }),
  );
  return unsubscribe;
}
