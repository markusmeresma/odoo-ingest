import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

import type { AppConfig, JsonValue, ModelConfig, OdooDomain } from "./types";

const DEFAULT_CURSOR_FIELD = "write_date";
const DEFAULT_OVERLAP_SECONDS = 120;
const DEFAULT_PAGE_SIZE = 500;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, fieldName: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${fieldName} to be an object.`);
  }
  return value as UnknownRecord;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected ${fieldName} to be a non-empty string.`);
  }
  return value;
}

function requiredInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Expected ${fieldName} to be an integer.`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, fieldName: string): number {
  const intValue = requiredInteger(value, fieldName);
  if (intValue < 0) {
    throw new Error(`Expected ${fieldName} to be >= 0.`);
  }
  return intValue;
}

function requiredPositiveInteger(value: unknown, fieldName: string): number {
  const intValue = requiredInteger(value, fieldName);
  if (intValue <= 0) {
    throw new Error(`Expected ${fieldName} to be > 0.`);
  }
  return intValue;
}

function requiredStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Expected ${fieldName} to be a non-empty array.`);
  }

  return value.map((entry, index) => requiredString(entry, `${fieldName}[${index}]`));
}

function optionalDomain(value: unknown, fieldName: string): OdooDomain {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected ${fieldName} to be an array.`);
  }

  return value as JsonValue[];
}

function loadModels(rawModels: unknown): ModelConfig[] {
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    throw new Error("Expected models to be a non-empty array.");
  }

  return rawModels.map((rawModel, index) => {
    const model = asRecord(rawModel, `models[${index}]`);
    const modelName = requiredString(model.name, `models[${index}].name`);

    const cursorFieldRaw = model.cursor_field ?? DEFAULT_CURSOR_FIELD;
    const overlapRaw = model.overlap_seconds ?? DEFAULT_OVERLAP_SECONDS;
    const pageSizeRaw = model.page_size ?? DEFAULT_PAGE_SIZE;

    return {
      name: modelName,
      fields: requiredStringArray(model.fields, `models[${index}].fields`),
      domain: optionalDomain(model.domain, `models[${index}].domain`),
      cursor_field: requiredString(cursorFieldRaw, `models[${index}].cursor_field`),
      overlap_seconds: requiredNonNegativeInteger(overlapRaw, `models[${index}].overlap_seconds`),
      page_size: requiredPositiveInteger(pageSizeRaw, `models[${index}].page_size`),
    };
  });
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const resolvedPath = path.resolve(configPath);
  const fileContents = await readFile(resolvedPath, "utf8");
  const parsed = yaml.load(fileContents);
  const config = asRecord(parsed, "config root");

  const odoo = asRecord(config.odoo, "odoo");
  const postgres = asRecord(config.postgres, "postgres");
  const sync = asRecord(config.sync, "sync");

  const odooApiKey = process.env.ODOO_API_KEY;
  if (!odooApiKey || odooApiKey.trim() === "") {
    throw new Error("Missing required environment variable ODOO_API_KEY.");
  }

  const postgresPassword = process.env.POSTGRES_PASSWORD;
  if (!postgresPassword || postgresPassword.trim() === "") {
    throw new Error("Missing required environment variable POSTGRES_PASSWORD.");
  }

  return {
    odoo: {
      base_url: requiredString(odoo.base_url, "odoo.base_url"),
      database: requiredString(odoo.database, "odoo.database"),
      username: requiredString(odoo.username, "odoo.username"),
      api_key: odooApiKey,
    },
    postgres: {
      host: requiredString(postgres.host, "postgres.host"),
      port: requiredPositiveInteger(postgres.port, "postgres.port"),
      database: requiredString(postgres.database, "postgres.database"),
      user: requiredString(postgres.user, "postgres.user"),
      password: postgresPassword,
    },
    sync: {
      request_timeout_seconds: requiredPositiveInteger(sync.request_timeout_seconds, "sync.request_timeout_seconds"),
      max_retries: requiredNonNegativeInteger(sync.max_retries, "sync.max_retries"),
      backoff_base_ms: requiredPositiveInteger(sync.backoff_base_ms, "sync.backoff_base_ms"),
    },
    models: loadModels(config.models),
  };
}
