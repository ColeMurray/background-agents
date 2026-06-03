import { describe, expect, it } from "vitest";
import { normalizeSandboxRuntimeSettings, resolveSandboxImageProfile } from "./integrations";

describe("sandbox settings helpers", () => {
  it("normalizes runtime sandbox settings at untrusted boundaries", () => {
    expect(
      normalizeSandboxRuntimeSettings({
        tunnelPorts: ["3000", 5173, -1, 70000, 3001],
        terminalEnabled: "true",
        dockerEnabled: true,
        maxConcurrentChildSessions: 2,
        maxTotalChildSessions: 0,
      })
    ).toEqual({
      tunnelPorts: [5173, 3001],
    });
  });

  it("resolves Docker image profile from normalized settings", () => {
    expect(resolveSandboxImageProfile({ dockerEnabled: true })).toBe("docker");
    expect(resolveSandboxImageProfile({ dockerEnabled: "true" as unknown as boolean })).toBe(
      "default"
    );
  });
});
