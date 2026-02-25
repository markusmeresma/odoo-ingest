import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { Logger } from "./logger";
import { OdooClient } from "./odoo-client";
import { RawRecordStore } from "./raw-record-store";
import { StateStore } from "./state-store";
import type { AppConfig, ModelConfig, OdooDomain, OdooRecord } from "./types";

const GLOBAL_ADVISORY_LOCK_ID = 41023017;

interface CursorPoint {
  value: string;
  id: number;
}

function toOdooTimestampUtc(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function parseRecordId(record: OdooRecord, modelName: string): number {
  if (typeof record.id === "number" && Number.isInteger(record.id)) {
    return record.id;
  }

  if (typeof record.id === "string" && /^\d+$/.test(record.id)) {
    return Number.parseInt(record.id, 10);
  }

  throw new Error(`Record in model ${modelName} has an invalid id value.`);
}

function getRecordCursor(record: OdooRecord, modelName: string, cursorField: string): string {
  const cursorValue = record[cursorField];
  if (typeof cursorValue !== "string" || cursorValue.trim() === "") {
    throw new Error(`Record in model ${modelName} has invalid ${cursorField} cursor value.`);
  }
  return cursorValue;
}

function maxCursorPoint(records: OdooRecord[], modelName: string, cursorField: string): CursorPoint {
  let currentMax: CursorPoint | null = null;

  for (const record of records) {
    const id = parseRecordId(record, modelName);
    const cursor = getRecordCursor(record, modelName, cursorField);

    if (!currentMax) {
      currentMax = { value: cursor, id };
      continue;
    }

    if (cursor > currentMax.value || (cursor === currentMax.value && id > currentMax.id)) {
      currentMax = { value: cursor, id };
    }
  }

  if (!currentMax) {
    throw new Error(`Unable to compute max cursor for model ${modelName}.`);
  }

  return currentMax;
}

function buildDomain(model: ModelConfig, windowStart: string | null, pageCursor: CursorPoint | null): OdooDomain {
  const domain: unknown[] = [...model.domain];

  if (windowStart) {
    domain.push([model.cursor_field, ">=", windowStart]);
  }

  if (pageCursor) {
    domain.push(
      "|",
      [model.cursor_field, ">", pageCursor.value],
      "&",
      [model.cursor_field, "=", pageCursor.value],
      ["id", ">", pageCursor.id],
    );
  }

  return domain as OdooDomain;
}

export class SyncRunner {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly odooClient: OdooClient,
    private readonly stateStore: StateStore,
    private readonly rawRecordStore: RawRecordStore,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    const useAdvisoryLock = this.config.postgres.lock_strategy === "advisory";
    const lockClient = useAdvisoryLock ? await this.pool.connect() : null;
    let lockAcquired = false;
    const failedModels: string[] = [];

    try {
      if (useAdvisoryLock) {
        if (!lockClient) {
          throw new Error("Failed to initialize advisory lock client.");
        }

        const result = await lockClient.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS acquired",
          [GLOBAL_ADVISORY_LOCK_ID],
        );

        lockAcquired = result.rows[0]?.acquired === true;
        if (!lockAcquired) {
          this.logger.warn("Another sync process holds the advisory lock; exiting.", {
            lockId: GLOBAL_ADVISORY_LOCK_ID,
          });
          return;
        }

        this.logger.info("Acquired advisory lock.", { lockId: GLOBAL_ADVISORY_LOCK_ID });
      } else {
        this.logger.info("Skipping advisory lock due to configured lock strategy.", {
          lockStrategy: this.config.postgres.lock_strategy,
        });
      }

      for (const model of this.config.models) {
        const success = await this.runModel(model);
        if (!success) {
          failedModels.push(model.name);
        }
      }

      if (failedModels.length > 0) {
        throw new Error(`One or more model syncs failed: ${failedModels.join(", ")}`);
      }
    } finally {
      if (lockClient && lockAcquired) {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [GLOBAL_ADVISORY_LOCK_ID]);
      }
      lockClient?.release();
    }
  }

  private async runModel(model: ModelConfig): Promise<boolean> {
    const runId = randomUUID();

    await this.stateStore.startRun(model.name, runId);
    this.logger.info("Starting model sync.", { model: model.name, runId });

    try {
      await this.syncModel(model, runId);
      await this.stateStore.markLastSuccessRun(model.name, model.cursor_field, runId);
      await this.stateStore.finishRun(runId, "success");
      this.logger.info("Model sync completed.", { model: model.name, runId });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.stateStore.finishRun(runId, "failed", errorMessage);
      this.logger.error("Model sync failed.", { model: model.name, runId, error: errorMessage });
      return false;
    }
  }

  private async syncModel(model: ModelConfig, runId: string): Promise<void> {
    const existingState = await this.stateStore.getState(model.name);

    if (existingState && existingState.cursor_field !== model.cursor_field) {
      this.logger.warn("Configured cursor field differs from stored state cursor field.", {
        model: model.name,
        storedCursorField: existingState.cursor_field,
        configuredCursorField: model.cursor_field,
      });
    }

    let windowStart: string | null = null;
    if (existingState?.cursor_value) {
      const cursorDate = new Date(existingState.cursor_value);
      if (Number.isNaN(cursorDate.getTime())) {
        throw new Error(`Invalid cursor timestamp in state for model ${model.name}.`);
      }
      cursorDate.setUTCSeconds(cursorDate.getUTCSeconds() - model.overlap_seconds);
      windowStart = toOdooTimestampUtc(cursorDate);
    }

    let pageCursor: CursorPoint | null = null;

    while (true) {
      const domain = buildDomain(model, windowStart, pageCursor);
      const order = `${model.cursor_field} asc, id asc`;
      const records = await this.odooClient.searchRead(model.name, domain, model.fields, order, model.page_size);

      if (records.length === 0) {
        return;
      }

      const maxCursor = maxCursorPoint(records, model.name, model.cursor_field);

      const txClient = await this.pool.connect();
      try {
        await txClient.query("BEGIN");

        const upsertedCount = await this.rawRecordStore.upsertBatch(txClient, model.name, records, runId);

        await this.stateStore.updateState(
          txClient,
          model.name,
          model.cursor_field,
          maxCursor.value,
          maxCursor.id,
        );

        await this.stateStore.updateRunProgress(txClient, runId, {
          recordsReadDelta: records.length,
          recordsUpsertedDelta: upsertedCount,
          pagesProcessedDelta: 1,
        });

        await txClient.query("COMMIT");
      } catch (error) {
        await txClient.query("ROLLBACK");
        throw error;
      } finally {
        txClient.release();
      }

      pageCursor = maxCursor;

      this.logger.info("Processed sync page.", {
        model: model.name,
        runId,
        pageSize: records.length,
        cursorValue: maxCursor.value,
        cursorId: maxCursor.id,
      });

      if (records.length < model.page_size) {
        return;
      }
    }
  }
}
