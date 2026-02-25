# odoo-ingest

Incremental ingestion from Odoo JSON-RPC into Postgres JSONB.

This ingestor:
- Authenticates to Odoo with an API key.
- Fetches configured Odoo models via `search_read`.
- Syncs incrementally using a cursor (default `write_date`) plus overlap window.
- Upserts one row per `(model, odoo_id)` into `odoo_raw_records`.
- Tracks checkpoint state and run history for resumable syncs.

## Requirements

- Node.js 18+
- A Postgres database (local/self-hosted or Supabase)
- Odoo credentials with API key access

## Quick Start

1. Install dependencies.

```bash
npm ci
```

2. Create the Postgres schema.

```bash
psql "$YOUR_POSTGRES_URL" -f sql/001_init.sql
```

3. Create environment variables.

```bash
cp .env.example .env
```

4. Set secrets in `.env`.
Set `ODOO_API_KEY` in all cases. Set `POSTGRES_PASSWORD` for local config. Set `DATABASE_URL` for Supabase config.

5. Choose and edit a config file.
Use `config.local.yml` for local/self-hosted Postgres, or `config.supabase.yml` for Supabase.

6. Build.

```bash
npm run build
```

7. Run a sync.

```bash
# Local/self-hosted Postgres
node dist/cli.js sync --config config.local.yml

# Supabase
node dist/cli.js sync --config config.supabase.yml
```

## Config Notes

- Local mode uses:
`postgres.connection.type: "params"`, `ssl_mode: "disable"`, `lock_strategy: "advisory"`.

- Supabase mode uses:
`postgres.connection.type: "url"`, `ssl_mode: "require"`, `lock_strategy: "none"`.

- If your Supabase password contains URL-sensitive characters (`@`, `:`, `/`, `#`, `%`), URL-encode it in `DATABASE_URL`.

## Output Tables

- `odoo_raw_records`: latest raw payload per Odoo record per model.
- `odoo_sync_state`: last committed cursor per model.
- `odoo_sync_runs`: run metadata, counters, and errors.

Schema is defined in `sql/001_init.sql`.

## Running on a Schedule

This project is a one-shot ingestor. Run it on an interval using cron, a workflow scheduler, or a Kubernetes CronJob.

Example cron (every 5 minutes):

```cron
*/5 * * * * /usr/bin/env node /path/to/odoo-ingest/dist/cli.js sync --config /path/to/odoo-ingest/config.local.yml
```

## Architecture

For implementation details, see `docs/minimal-architecture.md`.
