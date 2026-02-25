import "dotenv/config";

import { parseArgs } from "node:util";

import { Pool } from "pg";
import type { PoolConfig } from "pg";

import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { OdooClient } from "./odoo-client";
import { RawRecordStore } from "./raw-record-store";
import { StateStore } from "./state-store";
import { SyncRunner } from "./sync-runner";
import type { AppConfig } from "./types";

function usage(): string {
  return "Usage: node dist/cli.js sync --config <path-to-config.yml>";
}

function buildPoolConfig(config: AppConfig): PoolConfig {
  const poolConfig: PoolConfig = {};

  if (config.postgres.connection.type === "url") {
    poolConfig.connectionString = config.postgres.connection.url;
  } else {
    poolConfig.host = config.postgres.connection.host;
    poolConfig.port = config.postgres.connection.port;
    poolConfig.database = config.postgres.connection.database;
    poolConfig.user = config.postgres.connection.user;
    poolConfig.password = config.postgres.connection.password;
  }

  if (config.postgres.ssl_mode === "require") {
    poolConfig.ssl = {
      rejectUnauthorized: false,
    };
  }

  return poolConfig;
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

  const pool = new Pool(buildPoolConfig(config));

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
