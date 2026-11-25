/**
 * The one SQL boundary the agent store and its companions are written against.
 *
 * The store's driver members (ledger, history, events, archive, purge, reads)
 * and every companion (schedules, children, spills, projections) are written
 * once, with `?` placeholders, against a session that runs one statement in
 * the transaction it belongs to. SQLite binds `?` natively; the Postgres store
 * translates it to `$1…$n` before the statement reaches the client. What the
 * two databases do differently is named in `AgentSqlDialect` and nowhere else,
 * so a fix to a query is a fix on both.
 */
export type AgentSqlValue = string | number | null | Uint8Array;

/** One statement at a time, inside the transaction this session belongs to. */
export interface AgentSqlSession {
  all(sql: string, parameters?: readonly AgentSqlValue[]): Promise<readonly unknown[]>;
  /** The first row, or `undefined` when there is none. */
  get(sql: string, parameters?: readonly AgentSqlValue[]): Promise<unknown>;
  run(sql: string, parameters?: readonly AgentSqlValue[]): Promise<void>;
}

/** Table names are library constants built from a validated prefix, never request data. */
export interface AgentSqlTables {
  readonly meta: string;
  readonly heads: string;
  readonly runs: string;
  readonly admissions: string;
  readonly messages: string;
  readonly seeds: string;
  readonly events: string;
  readonly eventSeq: string;
  readonly projections: string;
  readonly spills: string;
  readonly schedules: string;
  readonly children: string;
  readonly purged: string;
  /** Postgres only: the event search index and how far it has read each conversation. */
  readonly eventSearch: string;
  readonly eventSearchState: string;
}

export function agentSqlTables(prefix: string): AgentSqlTables {
  return {
    meta: `${prefix}_meta`,
    heads: `${prefix}_heads`,
    runs: `${prefix}_runs`,
    admissions: `${prefix}_admissions`,
    messages: `${prefix}_messages`,
    seeds: `${prefix}_seeds`,
    events: `${prefix}_events`,
    eventSeq: `${prefix}_event_seq`,
    projections: `${prefix}_projections`,
    spills: `${prefix}_spills`,
    schedules: `${prefix}_schedules`,
    children: `${prefix}_children`,
    purged: `${prefix}_purged`,
    eventSearch: `${prefix}_event_search`,
    eventSearchState: `${prefix}_event_search_state`,
  };
}

/** What differs between the two databases, and only that. */
export interface AgentSqlDialect {
  readonly name: 'sqlite' | 'postgres';
  readonly tables: AgentSqlTables;
  /**
   * Every table keyed by `conversation_id`, in the order a purge deletes them.
   * Postgres has one more than SQLite: the per-conversation event counter.
   */
  readonly conversationTables: readonly string[];
  /** The column that orders message rows written at one position: `rowid` or `row_id`. */
  readonly messageRowId: string;
  /** A predicate that `column` contains the next parameter as a substring. */
  contains(column: string): string;
  /**
   * The next event number of one conversation.
   *
   * SQLite takes `MAX(seq) + 1`: its write transaction excludes every other
   * writer. Postgres cannot — two SERIALIZABLE writers read the same maximum
   * from their own snapshots — so it advances one counter row, whose lock
   * makes the second writer fail with a serialization error and retry.
   */
  nextEventSeq(session: AgentSqlSession, conversationId: string): Promise<number>;
  /**
   * Synchronize the search index after an in-place redaction of an existing event
   * row (such as purging expired encrypted `provider/payload` bodies).
   */
  syncUpdatedEventSearch(
    session: AgentSqlSession,
    event: {
      rowId?: number;
      conversationId: string;
      seq: number;
      occurredAt: string;
      payload: string;
    },
  ): Promise<void>;
}

/**
 * `?` placeholders to `$1…$n`, outside quoted literals and identifiers.
 *
 * The statements are the library's own, so a `?` inside a literal is a bug
 * in one of them rather than input; it is still skipped, not numbered, so the
 * count stays the parameter count.
 */
export function toNumberedPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let quote: "'" | '"' | undefined;
  for (const char of sql) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      out += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}
