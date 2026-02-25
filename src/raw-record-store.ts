import type { PoolClient } from "pg";

import type { OdooRecord } from "./types";

function normalizeOdooTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  // Odoo timestamps are timezone-less UTC strings: YYYY-MM-DD HH:MM:SS
  // Persist as TIMESTAMPTZ by explicitly appending +00.
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(value)) {
    return `${value}+00`;
  }

  return value;
}

function parseRecordId(record: OdooRecord, model: string): number {
  const idValue = record.id;
  if (typeof idValue === "number" && Number.isInteger(idValue)) {
    return idValue;
  }

  if (typeof idValue === "string" && /^\d+$/.test(idValue)) {
    return Number.parseInt(idValue, 10);
  }

  throw new Error(`Record in model ${model} is missing a valid integer id.`);
}

export class RawRecordStore {
  async upsertBatch(client: PoolClient, model: string, records: OdooRecord[], runId: string): Promise<number> {
    if (records.length === 0) {
      return 0;
    }

    const values: unknown[] = [];
    const valuePlaceholders: string[] = [];

    records.forEach((record, index) => {
      const offset = index * 6;
      valuePlaceholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6})`,
      );

      values.push(
        model,
        parseRecordId(record, model),
        normalizeOdooTimestamp(record.write_date),
        normalizeOdooTimestamp(record.create_date),
        JSON.stringify(record),
        runId,
      );
    });

    await client.query(
      `
      INSERT INTO odoo_raw_records (
        model,
        odoo_id,
        write_date,
        create_date,
        payload,
        run_id
      )
      VALUES ${valuePlaceholders.join(",")}
      ON CONFLICT (model, odoo_id)
      DO UPDATE SET
        write_date = EXCLUDED.write_date,
        create_date = EXCLUDED.create_date,
        payload = EXCLUDED.payload,
        synced_at = NOW(),
        run_id = EXCLUDED.run_id
      `,
      values,
    );

    return records.length;
  }
}
