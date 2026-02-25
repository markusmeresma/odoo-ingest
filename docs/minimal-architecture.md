# Minimal Architecture: Odoo JSON-RPC Incremental Connector

## Scope

This connector does the following:

1. Authenticate to Odoo via JSON-RPC.
2. Fetch model records via `search_read` with model, fields, domain, and pagination.
3. Incrementally sync by cursor (usually `write_date`) with overlap window.
4. Upsert one row per Odoo record into Postgres JSONB.
5. Run on an interval with retry, partial-failure recovery, and idempotent re-runs.

## Design principles

1. At-least-once fetch semantics.
2. Idempotent writes via deterministic upsert key: `(model, odoo_id)`.
3. Deterministic ordering for pagination: `order by <cursor_field> asc, id asc`.
4. Checkpoint after each page to make failures resumable.
5. Overlap window to protect against clock skew, commit lag, and retry gaps.

## Finalized implementation decisions

1. Runtime: Node.js.
2. Scheduler: external scheduler invoking a one-shot process each interval.
3. Authentication: Odoo API key.
4. Tenancy: single Odoo tenant.
5. Execution mode: sequential per model.
6. Initial backfill: full history.
7. Run retention: keep detailed run logs for 90 days.

## Runtime components

1. Scheduler
- External scheduler triggers a one-shot command at fixed interval.
- Recommended targets: cron, Kubernetes CronJob, or workflow scheduler.
- Rationale: simpler failure model and robust restart behavior.

2. Sync runner
- Acquires single-run lock (global or per model).
- Reads model configs.
- Runs each model sync loop sequentially.

3. Odoo client (JSON-RPC)
- Authenticates with API key.
- Executes `search_read` with:
  - `model`
  - `fields`
  - `domain`
  - `limit`
  - `offset` or keyset predicate
  - `order`
- Retries transient failures with backoff + jitter.

4. State store
- Persists cursor checkpoint per model.
- Persists run metadata (start/end/status/error/record counts).

5. Raw record store (Postgres)
- Upserts normalized envelope + raw payload JSONB.

## Incremental algorithm (per model)

Inputs:

- `model`
- `fields`
- `base_domain`
- `cursor_field` (default `write_date`)
- `overlap_seconds`
- `page_size`

State:

- `last_cursor_value` (timestamp)
- `last_cursor_id` (id tie-breaker)

Process:

1. Read state for model.
2. Build incremental domain:
- If no state exists, use `base_domain` (full history).
- If state exists, compute `window_start = last_cursor_value - overlap_seconds` and use `base_domain` AND records newer than `window_start`.
3. Paginate deterministically:
- `order = "<cursor_field> asc, id asc"`
- Use keyset filter for next page:
  - `<cursor_field> > page_cursor_value`
  - OR `<cursor_field> = page_cursor_value AND id > page_cursor_id`
4. For each page:
- Upsert all records into `odoo_raw_records`.
- Track max `(cursor_value, id)` seen in page.
- Commit page transaction:
  - page upserts
  - state checkpoint update
  - run progress update
5. On success:
- Mark run successful.
6. On failure:
- Mark run failed with error.
- Next run restarts from saved checkpoint minus overlap.

## Idempotency and failure handling

1. Upsert key
- Primary key `(model, odoo_id)` makes reruns safe.

2. Partial failures
- Page-level commits prevent total rerun of large syncs.
- Restart from last committed checkpoint with overlap.

3. Retries
- Retry JSON-RPC calls on network errors and 5xx-type failures.
- Do not retry validation/authentication errors indefinitely.

4. Duplicate tolerance
- Overlap intentionally re-fetches records.
- Upsert resolves duplicates safely.

## Minimal Postgres data model

Tables:

1. `odoo_raw_records`
- One row per Odoo record per model.
- Stores payload JSONB and metadata.

2. `odoo_sync_state`
- One row per model cursor state.

3. `odoo_sync_runs`
- Run audit log for observability and debugging.

SQL is defined in `sql/001_init.sql`.

## Minimal config contract

```yaml
odoo:
  base_url: "https://your-odoo-host"
  database: "odoo_db"
  username: "connector_user"
  api_key: "odoo-api-key"

sync:
  interval_seconds: 300
  mode: "oneshot"
  request_timeout_seconds: 60
  max_retries: 5
  backoff_base_ms: 500

models:
  - name: "res.partner"
    fields: ["id", "name", "write_date", "create_date"]
    domain: []
    cursor_field: "write_date"
    overlap_seconds: 120
    page_size: 500
```

## Minimal run lifecycle

1. Acquire lock.
2. Insert `odoo_sync_runs` row with `status=running`.
3. Execute model loops.
4. Update run counters while processing.
5. Mark `success` or `failed` and persist error text.
6. Release lock.

## Operational policies

1. Full-history bootstrap
- When no row exists in `odoo_sync_state` for a model, sync starts from earliest available data.
- Optional future enhancement: allow per-model `start_from` override.

2. Run retention
- Keep `odoo_sync_runs` rows for 90 days.
- Keep `odoo_sync_state` indefinitely.
- Suggested cleanup query (daily):

```sql
DELETE FROM odoo_sync_runs
WHERE started_at < NOW() - INTERVAL '90 days';
```

3. Schedule style
- Invoke a one-shot command every interval (example every 5 minutes):

```cron
*/5 * * * * /usr/bin/env node dist/cli.js sync --config /etc/odoo-ingest/config.yml
```
