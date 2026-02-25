import "dotenv/config";

import { parseArgs } from "node:util";

import { Pool } from "pg";

import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { OdooClient } from "./odoo-client";
import { RawRecordStore } from "./raw-record-store";
import { StateStore } from "./state-store";
import { SyncRunner } from "./sync-runner";

function usage(): string {
  return "Usage: node dist/cli.js sync --config <path-to-config.yml>";
}

async function main(): Promise<void> {
  const logger = createLogger({ component: "cli" });

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: {
        type: "string",
        short: "c",
      },
    },
  });

  const command = positionals[0];
  if (command !== "sync") {
    throw new Error(`Invalid command. ${usage()}`);
  }

  const configPath = values.config;
  if (!configPath) {
    throw new Error(`Missing --config flag. ${usage()}`);
  }

  const config = await loadConfig(configPath);

  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
  });

  try {
    const odooClient = new OdooClient(config.odoo, config.sync, createLogger({ component: "odoo-client" }));
    await odooClient.authenticate();
    logger.info("Authenticated with Odoo.");

    const stateStore = new StateStore(pool);
    const rawRecordStore = new RawRecordStore();

    const runner = new SyncRunner(
      pool,
      config,
      odooClient,
      stateStore,
      rawRecordStore,
      createLogger({ component: "sync-runner" }),
    );

    await runner.run();
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const logger = createLogger({ component: "cli" });
  const message = error instanceof Error ? error.message : String(error);
  logger.error("Fatal error.", { error: message });
  process.exitCode = 1;
});
