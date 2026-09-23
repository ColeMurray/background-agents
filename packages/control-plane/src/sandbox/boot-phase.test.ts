import { describe, expect, it } from "vitest";
import { parseStoredSandboxBootPhase, sandboxBootPhaseLogFields } from "./boot-phase";

describe("parseStoredSandboxBootPhase", () => {
  it("parses a stored boot phase", () => {
    const phase = {
      phase: "setup",
      status: "started",
      bootSeq: 3,
      repoOwner: "acme",
      repoName: "api",
    } as const;

    expect(parseStoredSandboxBootPhase(JSON.stringify(phase))).toEqual(phase);
  });

  it.each([null, "not-json", "{}"])("returns null for an unreadable phase %s", (value) => {
    expect(parseStoredSandboxBootPhase(value)).toBeNull();
  });
});

describe("sandboxBootPhaseLogFields", () => {
  it("uses the canonical flat fields and omits free-text detail", () => {
    expect(
      sandboxBootPhaseLogFields({
        phase: "setup",
        status: "started",
        bootSeq: 3,
        repoOwner: "acme",
        repoName: "api",
        detail: "arbitrary output",
      })
    ).toEqual({
      boot_seq: 3,
      phase: "setup",
      phase_status: "started",
      repo_owner: "acme",
      repo_name: "api",
      elapsed_ms: null,
      warning: false,
    });
  });
});
