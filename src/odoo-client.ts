import { randomUUID } from "node:crypto";

import type { OdooConfig, OdooDomain, OdooRecord, SyncConfig } from "./types";
import type { Logger } from "./logger";

interface JsonRpcSuccess<T> {
  jsonrpc: string;
  id: string;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: string;
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

class RetryableRequestError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RetryableRequestError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class OdooClient {
  private uid: number | null = null;
  private readonly endpoint: string;

  constructor(
    private readonly config: OdooConfig,
    private readonly syncConfig: SyncConfig,
    private readonly logger: Logger,
  ) {
    this.endpoint = `${this.config.base_url.replace(/\/+$/, "")}/jsonrpc`;
  }

  async authenticate(): Promise<number> {
    const result = await this.callRpc<unknown>({
      service: "common",
      method: "authenticate",
      args: [this.config.database, this.config.username, this.config.api_key, {}],
    });

    if (typeof result !== "number" || !Number.isInteger(result) || result <= 0) {
      throw new Error("Failed to authenticate with Odoo: invalid uid returned.");
    }

    this.uid = result;
    return result;
  }

  async searchRead(
    model: string,
    domain: OdooDomain,
    fields: string[],
    order: string,
    limit: number,
  ): Promise<OdooRecord[]> {
    if (this.uid === null) {
      throw new Error("Odoo client is not authenticated.");
    }

    const result = await this.callRpc<unknown>({
      service: "object",
      method: "execute_kw",
      args: [
        this.config.database,
        this.uid,
        this.config.api_key,
        model,
        "search_read",
        [domain],
        {
          fields,
          order,
          limit,
        },
      ],
    });

    if (!Array.isArray(result)) {
      throw new Error(`Expected search_read result array for model ${model}.`);
    }

    return result as OdooRecord[];
  }

  private async callRpc<T>(params: { service: string; method: string; args: unknown[] }): Promise<T> {
    const maxAttempts = this.syncConfig.max_retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.sendRequest<T>(params);
      } catch (error) {
        const canRetry = error instanceof RetryableRequestError && attempt < maxAttempts;
        if (!canRetry) {
          throw error;
        }

        const baseDelay = this.syncConfig.backoff_base_ms * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * this.syncConfig.backoff_base_ms);
        const delayMs = baseDelay + jitter;

        this.logger.warn("Retrying Odoo JSON-RPC request", {
          attempt,
          maxAttempts,
          delayMs,
          error: error.message,
        });

        await sleep(delayMs);
      }
    }

    throw new Error("Request failed after retries.");
  }

  private async sendRequest<T>(params: { service: string; method: string; args: unknown[] }): Promise<T> {
    const timeoutMs = this.syncConfig.request_timeout_seconds * 1000;

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params,
          id: randomUUID(),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RetryableRequestError("Network error calling Odoo JSON-RPC endpoint.", error);
    }

    if (response.status >= 500) {
      throw new RetryableRequestError(`Odoo JSON-RPC endpoint returned ${response.status}.`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authentication/authorization failed with HTTP ${response.status}.`);
    }

    if (!response.ok) {
      throw new Error(`Odoo JSON-RPC request failed with HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new RetryableRequestError("Failed to parse JSON-RPC response payload.", error);
    }

    const parsed = payload as JsonRpcSuccess<T> | JsonRpcFailure;
    if ((parsed as JsonRpcFailure).error) {
      const rpcError = (parsed as JsonRpcFailure).error;
      throw new Error(`Odoo JSON-RPC error ${rpcError.code}: ${rpcError.message}`);
    }

    return (parsed as JsonRpcSuccess<T>).result;
  }
}
