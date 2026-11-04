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
| visible time, scroll milestones, `data-track` clicks, raw first/current touch | channel classification, click-marker names, the attribute names |
| `dispositionTrackingBatch`, `issueVisitLease`, `activeIntervalOf`, presence | the tables, the transaction, adoption, geo, reports |

## Contract

```ts
import { createTrackingContract } from 'stitchkit/tracking/contract'

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
  clickIdParams: ['gclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'ttclid', 'fbclid'],
  isAction: isInteractionAction,
  onVisit: (visitId) => rum.setVisit(visitId),
})
```

`EventMetadataMap` is your `{ [type]: metadata }` map; `track` is typed by it:

```ts
client.track('ITEM_VIEW', { itemId, itemTitle })
client.track('SIGN_OUT')
```

Attribution carries observations, not a channel verdict. `utm` contains only the current URL's
`utm_*` parameters, retaining case and whitespace up to 200 characters per field; tags without
`utm_source` are valid. Parameter names are case-sensitive (`UTM_SOURCE` is not a tag), a repeated
tag keeps its first value, and a whitespace-only value is kept as the fact it is. `referrer` carries
the referring URL with credentials masked. Neither an external referrer nor a click marker creates
campaign tags. Classify the channel on your server.

Attribution belongs to the visit: the bootstrap entry carries it, and an event batch carries events
only. Join events to their visit on the server to attribute them.

`clickIdParams` is the application's ordered list of query-parameter names to recognise. There is no
built-in list: the first configured name with a nonempty value becomes `clickId` in the touch and
bootstrap entry. Only the name is retained, never the click ID's value: a referrer from your own site
repeats the landing query, so the value of every configured marker in a referrer is masked too. An empty
list collects none; names must contain 1–200 characters, and `createTrackingClient` refuses a list that
does not. Bootstrap collects these facts even if browser storage is unavailable.

`client.attribution()` returns `firstTouch` and `currentTouch`. The first is persisted for 90 days
by default; the current is this capture's raw context, so an untagged page does not inherit an earlier
campaign. The server owns any policy for retaining the last non-direct channel. Stored first-touch
records carry a format version; unversioned attribution is discarded because its tags may be inferred.

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

### Click URL retention

`resolveTrackedClick(target, { origin, hrefPolicy: 'full' })` and
`createTrackingClient({ …, hrefPolicy: 'full' })` retain the clicked URL's pathname,
query and fragment. Internal URLs are relative (`/item?offer=one#details`);
outbound URLs include their origin (`https://other.example/item?offer=one#details`).
URL credentials are excluded. Omitting the option, or selecting `path-only`,
keeps the default that omits query and fragment. Navigation classification,
labels and subscriptions are independent of this policy.

Full URLs may contain sensitive values. Supply your application's password and
secret redactor through `decorate` before enabling `full`: it receives the retained
`event.metadata.href` and must return the redacted metadata. The returned event is
what the outbox, synchronous unload and normal delivery receive. The framework
has no application-specific password policy. This option controls click and
outbound-click metadata; it does not change attribution, page tracking or interaction
metadata. Use the same redactor on your other ingestion paths.

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

## Real-visitor speed

`stitchkit/tracking/performance` collects Web Vitals from the people who use the site. Install the
optional peer `web-vitals` and call it once on the page:

```ts
import { createPerformanceCollector } from 'stitchkit/tracking/performance'

createPerformanceCollector({
  buildId: BUILD_ID,
  url: '/api/tracking/performance',
  visitId: () => client.visitId(),
})
```

The library is fetched as its own chunk after `load`, when the browser is idle, so the measurement costs
the page nothing it is measuring. Each load posts an `early` sample five seconds later and a `final` one
as the page goes, both with `sendBeacon` and the same `id`: keep the later one. The body is a string, so
the endpoint declares `safelistedBody: true`. A sample that could not leave waits in session storage for the
next page, up to 20 of them, and of one load only the newest.

A browser under automation sends nothing, and neither does an agent that admits to being Lighthouse,
headless Chrome, GTmetrix or a crawler. Lighthouse with its default settings imitates an ordinary browser, so a
local run with `webdriver` off cannot be told from a visitor.

One load is one document: a client-side navigation stays under the route the page opened on, and whatever
`web-vitals` reports after a back-forward restore is left out, because it would replace the load's numbers
with a restore's. A second call on a page returns the running collector.

A sample carries the route, the build, `mobile` or `desktop`, and the five metrics. **A metric that did not
arrive is `null`, never zero**: most visits have no INP at all, and a zero would pull every average down.

Parse a sample on your own endpoint and store it in your own table:

```ts
import { redactTrackingText } from 'stitchkit/tracking'
import { PerformanceSampleSchema, summarizePerformanceMetric } from 'stitchkit/tracking/contract'

const sample = PerformanceSampleSchema.parse(await request.json())
await samples.upsert({ ...sample, route: redactTrackingText(sample.route) })

const lcp = summarizePerformanceMetric(rows.map((row) => row.vitals.lcpMs))
// { samples: 42, p75: 1840, p95: null } — a p95 needs 100 samples
```

The report is yours: which routes matter and what is slow are the application's words.

## Privacy

`redactTrackingText` masks passwords, sign-in credentials, API keys, bearer tokens and signed Telegram launch
data in a URL or free text, and leaves paths and campaign parameters byte for byte. Text past 16 KiB is cut
first, because the endpoint is open to anyone. `code` and `hash` count only beside the
`state` or `auth_date` that makes them credentials, so a promo code stays. `redactTrackingValue` applies the
same rule through a value of any shape. The client applies it to the landing path, the referrer and the
campaign tags before sending or storing them. Apply it again on your ingest: anyone can post to that endpoint without running the client.

## Is tracking losing events?

`trackingTelemetryHealth(reports, baselines)` reads the outbox figures of a visit's bootstrap
(`browserStreamId` as `stream`, `outboxState`, `outboxQueued`, `outboxDropped`) and answers `ok`, `degraded` or
`unknown`. An application running without an outbox reports `unavailable` and reads as `degraded`. A browser repeats its lifetime `dropped` with
every visit, so pass what each stream reported before the window as `baselines`, and only the growth counts.

## Bundle weight

`stitchkit/tracking` has no `zod` in its graph: `createTrackingClient` with `indexedDbOutboxStorage` is under
8 KB gzip, a test holds that, and the build refuses a published file that reaches `zod`. The schemas live in
`stitchkit/tracking/contract` for the server and a shared contract. Importing that in code a browser loads
brings `zod` back, so keep a shared contract out of the storefront's client bundle.

## Not here

GeoIP, event labels, funnels, reports, the analytics page, Socket.IO push into
an admin UI, RUM — application code, and the reason two applications' tracking
looks different even though their mechanics are now one.
