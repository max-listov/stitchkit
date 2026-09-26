import type { SqliteDatabase } from '../../internal/sqlite';

/** Transaction body: occurrence time stays separate from retry and lease eligibility. */
export function migrateAgentRuntimeSqliteV3ToV4(database: SqliteDatabase): void {
  database.exec(`
    ALTER TABLE stitchkit_agent_runtime_schedules ADD COLUMN retry_at TEXT;
    ALTER TABLE stitchkit_agent_runtime_schedules ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE stitchkit_agent_runtime_schedules ADD COLUMN last_error TEXT;
    ALTER TABLE stitchkit_agent_runtime_schedules ADD COLUMN eligible_at TEXT
      GENERATED ALWAYS AS (MAX(next_at, COALESCE(retry_at, next_at), COALESCE(claim_until, next_at))) VIRTUAL;
    DROP INDEX stitchkit_agent_runtime_schedules_due;
    CREATE INDEX stitchkit_agent_runtime_schedules_due
      ON stitchkit_agent_runtime_schedules (eligible_at, id) WHERE state = 'scheduled';
    UPDATE stitchkit_agent_runtime_meta SET value = '4' WHERE key = 'schema_version';
  `);
}
