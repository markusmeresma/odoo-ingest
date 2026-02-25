export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type OdooDomain = JsonValue[];

export interface OdooConfig {
  base_url: string;
  database: string;
  username: string;
  api_key: string;
}

export type PostgresSslMode = "disable" | "require";

export type PostgresLockStrategy = "advisory" | "none";

export interface PostgresUrlConnection {
  type: "url";
  url: string;
}

export interface PostgresParamsConnection {
  type: "params";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type PostgresConnection = PostgresUrlConnection | PostgresParamsConnection;

export interface PostgresConfig {
  connection: PostgresConnection;
  ssl_mode: PostgresSslMode;
  lock_strategy: PostgresLockStrategy;
}

export interface SyncConfig {
  request_timeout_seconds: number;
  max_retries: number;
  backoff_base_ms: number;
}

export interface ModelConfig {
  name: string;
  fields: string[];
  domain: OdooDomain;
  cursor_field: string;
  overlap_seconds: number;
  page_size: number;
}

export interface AppConfig {
  odoo: OdooConfig;
  postgres: PostgresConfig;
  sync: SyncConfig;
  models: ModelConfig[];
}

export interface SyncState {
  model: string;
  cursor_field: string;
  cursor_value: string | null;
  cursor_id: number | null;
  last_success_run_id: string | null;
  updated_at: Date;
}

export type SyncRunStatus = "running" | "success" | "failed";

export interface SyncRun {
  run_id: string;
  model: string;
  status: SyncRunStatus;
  started_at: Date;
  finished_at: Date | null;
  records_read: number;
  records_upserted: number;
  pages_processed: number;
  error_message: string | null;
}

export interface OdooRecord {
  id: number;
  write_date?: string | null;
  create_date?: string | null;
  [key: string]: unknown;
}

export interface RunCounters {
  recordsReadDelta: number;
  recordsUpsertedDelta: number;
  pagesProcessedDelta: number;
}
