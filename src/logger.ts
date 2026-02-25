export type LogContext = Record<string, unknown>;

export interface Logger {
  info: (msg: string, extra?: LogContext) => void;
  warn: (msg: string, extra?: LogContext) => void;
  error: (msg: string, extra?: LogContext) => void;
}

function writeLine(level: "info" | "warn" | "error", msg: string, context: LogContext, extra?: LogContext): void {
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...context,
    ...(extra ?? {}),
  });

  if (level === "warn" || level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export function createLogger(context: LogContext = {}): Logger {
  return {
    info: (msg, extra) => writeLine("info", msg, context, extra),
    warn: (msg, extra) => writeLine("warn", msg, context, extra),
    error: (msg, extra) => writeLine("error", msg, context, extra),
  };
}
