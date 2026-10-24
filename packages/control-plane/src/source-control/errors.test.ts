import { describe, expect, it } from "vitest";
import { publicSourceControlError, SourceControlProviderError } from "./errors";

describe("publicSourceControlError", () => {
  it("redacts provider details while preserving retry classification", () => {
    const error = new SourceControlProviderError(
      "request failed with token secret-token",
      "transient",
      503
    );

    expect(publicSourceControlError(error, "Repository materialization failed")).toEqual({
      message: "Repository materialization failed",
      retryable: true,
    });
    expect(
      JSON.stringify(publicSourceControlError(error, "Repository materialization failed"))
    ).not.toContain("secret-token");
  });
});
