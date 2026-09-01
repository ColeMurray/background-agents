import { describe, expect, it } from "vitest";
import { Output } from "./output.js";
import { CliError } from "./errors.js";

describe("Output", () => {
  it("emits one JSON object per line for stream-json and keeps diagnostics off stdout", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = new Output("stream-json", {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    output.result({ id: 1 });
    output.result({ id: 2 });
    output.error("diagnostic");

    expect(stdout).toEqual(['{"id":1}\n', '{"id":2}\n']);
    expect(stderr).toEqual(["diagnostic\n"]);
  });

  it.each(["json", "stream-json"] as const)(
    "emits a stable structured error envelope for %s",
    (format) => {
      const stderr: string[] = [];
      const output = new Output(format, { stderr: (value) => stderr.push(value) });
      output.failure(new CliError("service", "Unavailable", 503, { idempotencyKey: "retry-id" }));
      expect(JSON.parse(stderr.join(""))).toEqual({
        error: {
          code: "service_unavailable",
          message: "Unavailable",
          status: 503,
          context: { idempotencyKey: "retry-id" },
        },
      });
    }
  );

  it("renders the complete error envelope in text mode, including retry context", () => {
    const stderr: string[] = [];
    new Output("text", { stderr: (value) => stderr.push(value) }).failure(
      new CliError("transport", "Request outcome unknown", undefined, {
        clientRequestId: "retry-id",
      })
    );
    expect(stderr).toEqual([
      'error: {"code":"service_unavailable","message":"Request outcome unknown","context":{"clientRequestId":"retry-id"}}\n',
    ]);
  });
});
