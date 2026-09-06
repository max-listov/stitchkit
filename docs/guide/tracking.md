# Visitor tracking

`stitchkit/tracking` is the browser half of visitor tracking — the outbox, the
visit lease, the page-leave beacon, visible time, scroll milestones,
declarative clicks, attribution — and `stitchkit/tracking/server` is the set of
decisions a tracking backend makes about what arrives. Neither has an event
vocabulary of its own, a database, or a React component: those are the
application's, and the boundary is deliberate. → ADR 0166

Both entrypoints are **evolving**.

## What the framework owns, and what you do

| Framework | Application |
|-----------|-------------|
| the event envelope, the batch, the dispositions, the visit entry and lease schemas | the event **types**, their metadata, their labels |
| the tab-shared outbox with reserved sequences and a short flush lease | which storage adapter (IndexedDB in a tab) |
| the page-leave beacon that arrives, and its queued insurance copy | the session, the router, the React provider |
| visible time, scroll milestones, `data-track` clicks, UTM first/current touch | the referrer → source map, the attribute names |
| `dispositionTrackingBatch`, `issueVisitLease`, `activeIntervalOf`, presence | the tables, the transaction, adoption, geo, reports |

## Contract

```ts
import { createTrackingContract } from 'stitchkit/tracking'

export const tracking = createTrackingContract({
  scope: 'public',
  eventTypes: ['PAGE_VIEW', 'PAGE_LEAVE', 'SCROLL_DEPTH', 'SESSION_HEARTBEAT', 'CLICK', 'OUTBOUND_CLICK', 'INTERACTION', 'ITEM_VIEW'],
  // eventExtras: z.object({ locale: z.string() }),   // fields you carry beside the envelope
})
```

Two operations: `bootstrap` (`POST /visit`) issues or renews a visit lease,
`track` (`POST /events`) receives a batch. `track` declares
`safelistedBody: true`, because the page-leave event is a string beacon — the
only body a document that is being unloaded can deliver to another origin —
and that in turn requires an explicit `cors.origin` allow-list on the server.
Read [safelisted request bodies](./server.md#safelisted-request-bodies-beacons)
before deploying: it is one rule, and it is the one that keeps the beacon path
from being a CSRF hole.

`scope: 'public'` is the usual choice: the landing page is read by anonymous
visitors, and their path is part of the funnel. Identity comes from the cookie
on the server side; the client claims nothing about itself.

## Browser

```ts
import {
  browserTrackingHost, CONVENTIONAL_TRACKING_EVENT_TYPES, createTrackingClient,
  createTrackingOutbox, indexedDbOutboxStorage,
} from 'stitchkit/tracking'

// Only the types the browser writes — a server-side event must not be trackable here.
type BrowserEvents = Pick<EventMetadataMap, ClientTrackingEventType>

const client = createTrackingClient<BrowserEvents>({
  host: browserTrackingHost(),
  buildId: env.NEXT_PUBLIC_BUILD_ID, // a typed env accessor; the client refuses `undefined`
  builtin: CONVENTIONAL_TRACKING_EVENT_TYPES,       // your names for the events the client emits
  bootstrap: (entry) => api.tracking.bootstrap(entry),
  deliver: (batch) => api.tracking.track(batch),   // or a socket first, HTTP as the fallback
  unloadUrl: urls.tracking.track(),
  outbox: createTrackingOutbox(indexedDbOutboxStorage('my-app-tracking')),
  referrerMap: [{ pattern: /t\.me|telegram\.org/, source: 'telegram', medium: 'social' }],
  isAction: isInteractionAction,
  onVisit: (visitId) => rum.setVisit(visitId),
})
```

`EventMetadataMap` is your `{ [type]: metadata }` map; `track` is typed by it:

```ts
client.track('ITEM_VIEW', { itemId, itemTitle })
client.track('SIGN_OUT')
```

Two knobs match the client to your schema: `batchSize` is the contract's
`maxEventsPerBatch` (a larger batch is a `400` the outbox can never retire),
and `decorate` adds your `eventExtras` — a locale, an area, or the identity a
client that cannot send headers on unload has to carry in the body — to every
event as it is minted, so the outbox, the beacon and `deliver` all see it:

```ts
createTrackingClient<BrowserEvents, TrackingEventEnvelope<keyof BrowserEvents> & { locale: string }>({
  decorate: (event) => ({ ...event, locale: currentLocale() }),
  // …
})
```

A `bootstrap` operation that needs extra fields of its own (a locale, a RUM
flag) is not the factory's: build the `entry` schema with
`createTrackingSchemas(…).entry.extend({ … })` and declare that endpoint yourself.

The client owns the mechanics that were the same in every application that
wrote them: the visit lease and its renewal after a long sleep, a pending queue
until the visit exists, synchronous event identity from a block of reserved
sequence numbers, the outbox and its flush lease, one bounded delivery retry,
the page-leave beacon *and* its queued copy, additive visible time, scroll
milestones, `data-track` / `data-track-action` clicks, heartbeats. It does not
own the router or React — tell it about navigation, and wrap it yourself:

```tsx
const TrackerContext = createContext<TrackFn<BrowserEvents> | null>(null)

export function TrackingProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createTrackingClient<BrowserEvents>({ /* as above */ }))
  const pathname = usePathname()
  const search = useSearchParams().toString()
  useEffect(() => client.start(), [client])
  useEffect(() => client.onNavigate(pathname, search ? `?${search}` : ''), [client, pathname, search])
  return <TrackerContext.Provider value={client.track}>{children}</TrackerContext.Provider>
}

export const useTracker = () => useContext(TrackerContext) ?? (() => { throw new Error('outside TrackingProvider') })()
```

A component that records "opened X" can mount twice on one page; keep that
memory at document scope with `createOncePerPage`, not in a ref.

### Why these details are not optional

Four of them were found the expensive way, by consuming applications, and each
is a test in this repository that reddens when the mechanism is put back:

- the beacon body is a **string** — a `Blob` typed `application/json` reports
  `true` and dies on the preflight it cannot have;
- the event gets its sequence number **before** it is written — awaiting the
  outbox inside `pagehide` loses the event with the document;
- the flush lease is **short and released on leave** — a ten-second lease a
  dying document kept delayed the next document's first flush by ten seconds;
- `oncePerPage` lives at document scope — a remounted component has fresh refs.

## Server

The server half is pure. Read from your database, decide, write:

```ts
import { activeIntervalOf, dispositionTrackingBatch, hashTrackingEvent, issueVisitLease } from 'stitchkit/tracking/server'

track: async ({ input, ipAddress, userAgent }) => {
  const actorOwnerId = session?.userId ?? null
  const visits = await db.visit.findMany({ where: { id: { in: input.events.map((e) => e.visitId) } } })
  const stored = await db.trackingEvent.findMany({ where: { clientEventId: { in: input.events.map((e) => e.eventId) } } })
  const decided = dispositionTrackingBatch({
    events: input.events,
    visits: visits.map((v) => ({ id: v.id, browserStreamId: v.browserStreamId, ownerId: v.userId })),
    existing: new Map(stored.map((e) => [e.clientEventId, e.clientPayloadHash])),
    actorOwnerId,
    userAgent,
  })
  const now = new Date()
  await db.$transaction(async (tx) => {
    for (const visitId of decided.adoptable) await adoptVisit(tx, visitId, actorOwnerId, now)
    await tx.trackingEvent.createMany({
      data: decided.accepted.map((event, ordinal) => ({
        ...yourColumns(event), clientPayloadHash: hashTrackingEvent(event), serverItemOrdinal: ordinal, createdAt: now,
      })),
    })
    for (const event of decided.accepted) {
      const interval = activeIntervalOf(event, now)
      if (interval) await tx.activeTimeInterval.upsert(/* by interval.intervalId */)
    }
  })
  return { accepted: decided.accepted.length, dispositions: decided.dispositions }
}
```

`hashTrackingEvent` is `sha256(JSON.stringify(parsedEvent))` with no key
sorting — exactly what applications already store, so a migration does not
spend a week reporting conflicts. `decided.conflicts` names duplicates whose
payload changed; log them.

`issueVisitLease` runs the visit algorithm over a store you implement — six
methods over your tables, inside a lineage lock you hold (`pg_advisory_xact_lock`
over the browser stream id is the usual one):

```ts
const store: TrackingVisitStore<Prisma.TransactionClient> = {
  withLineageLock: (lineage, fn) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lineage}))`
    return fn(tx)
  }),
  findActive: (tx, q) => tx.visit.findFirst({ where: { /* q.browserStreamId, q.cutoff, ownership */ } }),
  touch: (tx, id, now, health) => tx.visit.update({ where: { id }, data: { lastActivityAt: now, ...health } }),
  adopt: (tx, visit, ownerId, now) => /* assign the owner, back-fill events, record the merge */,
  endOpen: (tx, lineage, now) => tx.visit.updateMany({ where: { browserStreamId: lineage, endedAt: null }, data: { endedAt: now } }),
  create: (tx, visit, health) => tx.visit.create({ data: { id: visit.id, ...deviceGeoAndSource(visit) , ...health } }),
}

bootstrap: ({ input, userAgent }) =>
  issueVisitLease(store, { ownerId: session?.userId ?? null, userAgent }, input, { ownership: 'adopting' })
```

`ownership` is the one policy two applications disagreed on: `'adopting'`
continues an anonymous visit and gives it to the caller who signs in — the
path from the landing page to the first signed-in action becomes one path; `'owned'` never
continues an anonymous visit, for an application where every visitor already
has an identity. A bot gets a lease that no store holds, so its events are
`identity-invalid` and nothing of it reaches a report.

`createPresenceRegistry` is who is here now, in this process: touch it from
`track`, read it for a live feed. It is honestly empty after a restart.

## Not here

GeoIP, event labels, funnels, reports, the analytics page, Socket.IO push into
an admin UI, RUM — application code, and the reason two applications' tracking
looks different even though their mechanics are now one.
