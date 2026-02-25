BEGIN;

CREATE TABLE IF NOT EXISTS odoo_raw_records (
  model TEXT NOT NULL,
  odoo_id BIGINT NOT NULL,
  write_date TIMESTAMPTZ NULL,
  create_date TIMESTAMPTZ NULL,
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id UUID NULL,
  PRIMARY KEY (model, odoo_id)
);

CREATE INDEX IF NOT EXISTS idx_odoo_raw_records_model_write_date
  ON odoo_raw_records (model, write_date);

CREATE INDEX IF NOT EXISTS idx_odoo_raw_records_payload_gin
  ON odoo_raw_records
  USING GIN (payload);

CREATE TABLE IF NOT EXISTS odoo_sync_state (
  model TEXT PRIMARY KEY,
  cursor_field TEXT NOT NULL DEFAULT 'write_date',
  cursor_value TIMESTAMPTZ NULL,
  cursor_id BIGINT NULL,
  last_success_run_id UUID NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS odoo_sync_runs (
  run_id UUID PRIMARY KEY,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  records_read BIGINT NOT NULL DEFAULT 0,
  records_upserted BIGINT NOT NULL DEFAULT 0,
  pages_processed BIGINT NOT NULL DEFAULT 0,
  error_message TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_odoo_sync_runs_model_started_at
  ON odoo_sync_runs (model, started_at DESC);

COMMIT;
