import { describe, expect, it } from "vitest";
import { collectCredentialValues } from "./credential-values";

describe("collectCredentialValues", () => {
  it("collects full configured values and Authorization credential components", () => {
    expect(
      collectCredentialValues({
        Authorization: "Bearer bearer-secret",
        authorization: "Basic basic-secret",
        "X-Api-Key": "header-secret",
      })
    ).toEqual(
      new Set([
        "Bearer bearer-secret",
        "bearer-secret",
        "Basic basic-secret",
        "basic-secret",
        "header-secret",
      ])
    );
  });

  it("does not split scheme-like values from neutral fields", () => {
    expect(collectCredentialValues({ note: "Bearer ordinary-value" })).toEqual(
      new Set(["Bearer ordinary-value"])
    );
  });
});
