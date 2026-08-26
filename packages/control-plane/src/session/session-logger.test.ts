import { describe, it, expect } from "vitest";
import type { Logger } from "../logger";
import { createSessionScopedLogger } from "./session-logger";

interface Line {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

function recordingLogger(lines: Line[], childContexts: Record<string, unknown>[] = []): Logger {
  const push = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    lines.push({ level, msg, data });
  };
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: (context) => {
      childContexts.push(context);
      return recordingLogger(lines, childContexts);
    },
  };
}

describe("createSessionScopedLogger", () => {
  it("injects the session id current at emit time, not creation time", () => {
    const lines: Line[] = [];
    let currentId = "do-fallback-id";
    const log = createSessionScopedLogger(recordingLogger(lines), () => currentId);

    log.info("first");
    currentId = "public-session-name";
    log.warn("second");

    expect(lines).toEqual([
      { level: "info", msg: "first", data: { session_id: "do-fallback-id" } },
      { level: "warn", msg: "second", data: { session_id: "public-session-name" } },
    ]);
  });

  it("keeps the injection on children and lets explicit data override", () => {
    const lines: Line[] = [];
    const childContexts: Record<string, unknown>[] = [];
    const log = createSessionScopedLogger(recordingLogger(lines, childContexts), () => "sess-1");

    const child = log.child({ trace_id: "trace-9" });
    child.error("from child", { detail: 1 });
    child.info("override", { session_id: "explicit" });

    expect(childContexts).toEqual([{ trace_id: "trace-9" }]);
    expect(lines).toEqual([
      { level: "error", msg: "from child", data: { session_id: "sess-1", detail: 1 } },
      { level: "info", msg: "override", data: { session_id: "explicit" } },
    ]);
  });
});
