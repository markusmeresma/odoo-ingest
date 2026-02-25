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
- Acquires global lock via `pg_advisory_lock()` with a fixed lock ID. Auto-releases on process exit/disconnect.
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

### Secrets via environment variables

The following environment variables are **required** and must be set before running the connector:

- `ODOO_API_KEY` — Odoo API key for JSON-RPC authentication.
- `POSTGRES_PASSWORD` — Postgres password for the ingest database.

Secrets are never stored in the YAML config file.

### Config YAML

```yaml
odoo:
  base_url: "https://your-odoo-host"
  database: "odoo_db"
  username: "connector_user"
  # API key via ODOO_API_KEY env var

postgres:
  host: "localhost"
  port: 5432
  database: "ingest_db"
  user: "ingest_user"
  # password via POSTGRES_PASSWORD env var

sync:
  request_timeout_seconds: 60
  max_retries: 5
  backoff_base_ms: 500

models:
  # Defaults applied when not set per model:
  #   cursor_field: "write_date"
  #   overlap_seconds: 120
  #   page_size: 500

  - name: "sale.order"
    fields:
      - id
      - name
      - state
      - date_order
      - partner_id
      - partner_invoice_id
      - partner_shipping_id
      - user_id
      - team_id
      - company_id
      - currency_id
      - pricelist_id
      - amount_untaxed
      - amount_tax
      - amount_total
      - invoice_status
      - note
      - origin
      - client_order_ref
      - write_date
      - create_date
    domain: []

  - name: "sale.order.line"
    fields:
      - id
      - order_id
      - product_id
      - product_template_id
      - name
      - product_uom_qty
      - qty_delivered
      - qty_invoiced
      - price_unit
      - discount
      - price_subtotal
      - price_total
      - product_uom
      - currency_id
      - state
      - write_date
      - create_date
    domain: []

  - name: "res.partner"
    fields:
      - id
      - name
      - display_name
      - email
      - phone
      - mobile
      - street
      - street2
      - city
      - state_id
      - zip
      - country_id
      - vat
      - company_type
      - is_company
      - parent_id
      - customer_rank
      - supplier_rank
      - active
      - lang
      - write_date
      - create_date
    domain: []

  - name: "product.template"
    fields:
      - id
      - name
      - default_code
      - type
      - categ_id
      - list_price
      - standard_price
      - uom_id
      - active
      - sale_ok
      - write_date
      - create_date
    domain: []

  - name: "product.product"
    fields:
      - id
      - product_tmpl_id
      - default_code
      - active
      - write_date
      - create_date
    domain: []

  - name: "res.users"
    fields:
      - id
      - name
      - login
      - email
      - active
      - partner_id
      - write_date
      - create_date
    domain: []

  - name: "crm.lead"
    fields:
      - id
      - name
      - type
      - stage_id
      - partner_id
      - user_id
      - team_id
      - expected_revenue
      - probability
      - date_deadline
      - date_open
      - date_closed
      - priority
      - active
      - lost_reason_id
      - company_id
      - email_from
      - phone
      - city
      - write_date
      - create_date
    domain: []

  - name: "account.move"
    fields:
      - id
      - name
      - move_type
      - state
      - date
      - invoice_date
      - invoice_date_due
      - partner_id
      - currency_id
      - company_id
      - amount_untaxed
      - amount_tax
      - amount_total
      - amount_residual
      - payment_state
      - invoice_origin
      - ref
      - write_date
      - create_date
    domain: [["move_type", "in", ["out_invoice", "out_refund"]]]
```

## Minimal run lifecycle

1. Acquire global lock via `pg_advisory_lock(<fixed_lock_id>)`. If another process holds the lock, the call blocks until it is released (or use `pg_try_advisory_lock` to exit immediately).
2. Insert `odoo_sync_runs` row with `status=running`.
3. Execute model loops.
4. Update run counters while processing.
5. Mark `success` or `failed` and persist error text.
6. Lock auto-releases on disconnect/process exit.

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

## Known limitations

- **Deletions not detected**: Records deleted in Odoo remain in Postgres indefinitely. The connector only tracks creates and updates via `write_date` cursor. Deletion reconciliation is deferred to a future version.

## Extendability

To add a new Odoo model to the sync:

1. Add an entry to the `models:` array in config YAML with `name`, `fields`, and `domain`.
2. Optionally override `cursor_field`, `overlap_seconds`, or `page_size` (defaults apply otherwise).
3. On next run, the connector detects no state for the new model and performs a full-history backfill.
4. No code changes required.
