import { describe, expect, it } from "vitest";
import { buildControlPlanePath } from "./control-plane-query";

describe("buildControlPlanePath", () => {
  it("forwards allowed query parameters in allowlist order", () => {
    const searchParams = new URLSearchParams("offset=20&debug=true&limit=10&status=running");

    expect(buildControlPlanePath("/sessions", searchParams)).toBe(
      "/sessions?status=running&limit=10&offset=20"
    );
  });

  it("omits query strings when no allowed parameters are present", () => {
    const searchParams = new URLSearchParams("repoOwner=open-inspect&trace=1");

    expect(buildControlPlanePath("/automations", searchParams)).toBe("/automations");
  });

  it("preserves empty allowed values", () => {
    const searchParams = new URLSearchParams("limit=&status=");

    expect(buildControlPlanePath("/automations/run", searchParams)).toBe(
      "/automations/run?status=&limit="
    );
  });
});
