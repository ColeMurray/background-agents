import { expect, it } from "vitest";
import { sanitizedDiagnostic } from "./diagnostics";

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
