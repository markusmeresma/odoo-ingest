import type { Pool, PoolClient } from "pg";

import type { RunCounters, SyncRunStatus, SyncState } from "./types";

interface SyncStateRow {
  model: string;
  cursor_field: string;
  cursor_value: Date | null;
  cursor_id: number | null;
  last_success_run_id: string | null;
  updated_at: Date;
}

export class StateStore {
  constructor(private readonly pool: Pool) {}

  async getState(model: string): Promise<SyncState | null> {
    const result = await this.pool.query<SyncStateRow>(
      `
      SELECT
        model,
        cursor_field,
        cursor_value,
        cursor_id,
        last_success_run_id,
        updated_at
      FROM odoo_sync_state
      WHERE model = $1
      `,
      [model],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];

    return {
      model: row.model,
      cursor_field: row.cursor_field,
      cursor_value: row.cursor_value ? row.cursor_value.toISOString() : null,
      cursor_id: row.cursor_id,
      last_success_run_id: row.last_success_run_id,
      updated_at: row.updated_at,
    };
  }

  async updateState(
    client: PoolClient,
    model: string,
    cursorField: string,
    cursorValue: string,
    cursorId: number,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO odoo_sync_state (
        model,
        cursor_field,
        cursor_value,
        cursor_id,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (model)
      DO UPDATE SET
        cursor_field = EXCLUDED.cursor_field,
        cursor_value = EXCLUDED.cursor_value,
        cursor_id = EXCLUDED.cursor_id,
        updated_at = NOW()
      `,
      [model, cursorField, `${cursorValue}+00`, cursorId],
    );
  }

  async markLastSuccessRun(model: string, cursorField: string, runId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO odoo_sync_state (
        model,
        cursor_field,
        last_success_run_id,
        updated_at
      )
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (model)
      DO UPDATE SET
        last_success_run_id = EXCLUDED.last_success_run_id,
        updated_at = NOW()
      `,
      [model, cursorField, runId],
    );
  }

  async startRun(model: string, runId: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO odoo_sync_runs (run_id, model, status)
      VALUES ($1, $2, 'running')
      `,
      [runId, model],
    );
  }

  async updateRunProgress(client: PoolClient, runId: string, counters: RunCounters): Promise<void> {
    await client.query(
      `
      UPDATE odoo_sync_runs
      SET
        records_read = records_read + $2,
        records_upserted = records_upserted + $3,
        pages_processed = pages_processed + $4
      WHERE run_id = $1
      `,
      [
        runId,
        counters.recordsReadDelta,
        counters.recordsUpsertedDelta,
        counters.pagesProcessedDelta,
      ],
    );
  }

  async finishRun(runId: string, status: SyncRunStatus, errorMessage?: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE odoo_sync_runs
      SET
        status = $2,
        finished_at = NOW(),
        error_message = $3
      WHERE run_id = $1
      `,
      [runId, status, errorMessage ?? null],
    );
  }
}
