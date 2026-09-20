import { describe, expect, it } from "vitest";
import { MIN_PRESERVATION_RUNTIME_GENERATION } from "../runtime-manifest";
import { preservationPolicyForLaunch, supportsConfirmedPreservation } from "./preservation-policy";

describe("preservation lifecycle policy", () => {
  it("requires confirmed preservation for every new launch", () => {
    expect(preservationPolicyForLaunch("new", null)).toBe("confirmed");
    expect(preservationPolicyForLaunch("new", "v1-legacy")).toBe("confirmed");
  });

  it("keeps existing state legacy until its runtime is known capable", () => {
    expect(preservationPolicyForLaunch("existing", null)).toBe("legacy");
    expect(
      preservationPolicyForLaunch("existing", `v${MIN_PRESERVATION_RUNTIME_GENERATION - 1}-legacy`)
    ).toBe("legacy");
    expect(
      preservationPolicyForLaunch("existing", `v${MIN_PRESERVATION_RUNTIME_GENERATION}-confirmed`)
    ).toBe("confirmed");
    expect(supportsConfirmedPreservation("invalid")).toBe(false);
  });
});
