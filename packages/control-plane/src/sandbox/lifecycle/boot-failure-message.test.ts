import { describe, expect, it } from "vitest";
import { formatBootBudgetFailure } from "./boot-failure-message";

const THIRTY_MINUTES_MS = 1_800_000;

describe("formatBootBudgetFailure", () => {
  it.each([
    ["starting", "starting the runtime"],
    ["sync", "cloning for group/subgroup/api"],
    ["setup", "running setup.sh for group/subgroup/api"],
    ["start", "running start.sh for group/subgroup/api"],
    ["skills", "installing managed skills"],
    ["harness", "starting the agent"],
  ])("names the %s boot phase", (phase, description) => {
    const bootPhase = JSON.stringify({
      phase,
      status: "started",
      repoOwner: "group/subgroup",
      repoName: "api",
    });

    expect(formatBootBudgetFailure(bootPhase, THIRTY_MINUTES_MS)).toBe(
      `Sandbox boot exceeded 30 minutes while ${description}. ` +
        "Raise SANDBOX_BOOT_TIMEOUT_MS if the boot legitimately needs longer, or make it return sooner."
    );
  });

  it.each([
    null,
    "",
    "not-json",
    "null",
    "{}",
    '{"phase":"future","status":"started"}',
    '{"phase":"setup"}',
    '{"phase":"setup","status":"unknown"}',
    '{"phase":"setup","status":"started","repoOwner":42}',
  ])("falls back to booting for absent or invalid phase %s", (bootPhase) => {
    expect(formatBootBudgetFailure(bootPhase, THIRTY_MINUTES_MS)).toContain("while booting.");
  });

  it("reports the configured budget in minutes and omits incomplete repository identity", () => {
    const bootPhase = JSON.stringify({ phase: "setup", status: "started", repoOwner: "acme" });

    expect(formatBootBudgetFailure(bootPhase, 250_000)).toContain(
      "exceeded 4 minutes while running setup.sh."
    );
  });

  it.each(["completed", "failed"])("describes a valid %s phase report", (status) => {
    const bootPhase = JSON.stringify({
      phase: "harness",
      status,
      bootSeq: 5,
      sandboxId: "sb-123",
      elapsedMs: 100,
    });

    expect(formatBootBudgetFailure(bootPhase, THIRTY_MINUTES_MS)).toContain(
      "while starting the agent."
    );
  });
});
