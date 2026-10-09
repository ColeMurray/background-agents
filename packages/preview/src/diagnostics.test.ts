import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readLogTail, sanitizedDiagnostic } from "./diagnostics";

it("preserves nested causes and bounded evidence while redacting fixture credentials", () => {
  const error = new AggregateError(
    [new Error("fixture: GET https://api.github.com/unexpected"), new Error("cleanup failed")],
    "Startup and cleanup failed"
  );
  const text = sanitizedDiagnostic(
    error,
    "x".repeat(20_000) + "\nError: fixture-secret Bearer unknown-token\ncookie-value",
    ["fixture-secret", "cookie-value"]
  );
  expect(text).toContain("GET https://api.github.com/unexpected");
  expect(text).toContain("cleanup failed");
  for (const secret of ["fixture-secret", "unknown-token", "cookie-value"])
    expect(text).not.toContain(secret);
  expect(text.length).toBeLessThan(13_000);
});

it("reads only a bounded tail of a large log, and nothing of a missing one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oi-preview-log-tail-"));
  try {
    const path = join(directory, "web.log");
    await writeFile(path, `${"x".repeat(4 * 1024 * 1024)}\nlast line: é ✓`);
    const tail = await readLogTail(path);
    expect(tail.length).toBeLessThan(100_000);
    expect(tail.endsWith("\nlast line: é ✓")).toBe(true);
    expect(sanitizedDiagnostic(new Error("failed"), tail, [])).toContain("last line: é ✓");
    expect(await readLogTail(join(directory, "missing.log"))).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
