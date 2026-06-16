export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function shouldLog(level: string, configured?: string): boolean {
  const order = ["debug", "info", "warn", "error"];
  const current = order.indexOf(configured || "info");
  const requested = order.indexOf(level);
  return requested >= (current === -1 ? 1 : current);
}

export function createLogger(component: string, configuredLevel?: string): Logger {
  function emit(level: "debug" | "info" | "warn" | "error", message: string, data = {}) {
    if (!shouldLog(level, configuredLevel)) return;
    console[level](JSON.stringify({ level, component, message, ...data }));
  }

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
    child: (context) => createLogger(`${component}:${JSON.stringify(context)}`, configuredLevel),
  };
}
