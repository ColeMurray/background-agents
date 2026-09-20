import {
  DEFAULT_VNC_PORT,
  INTERNAL_TTYD_PORT,
  INTERNAL_VNC_PORT,
} from "@open-inspect/shared/types/integrations";
import { describe, expect, it } from "vitest";
import { resolveSandboxPortPlan, resolveServicePorts, resolveTunnelPorts } from "./port-resolution";

describe("resolveServicePorts", () => {
  it("resolves the default and configured noVNC port", () => {
    expect(resolveServicePorts(undefined).vncPort).toBe(DEFAULT_VNC_PORT);
    expect(resolveServicePorts({ vncPort: 6099 }).vncPort).toBe(6099);
  });
});

describe("resolveTunnelPorts", () => {
  it("defensively excludes the internal raw VNC port", () => {
    expect(resolveTunnelPorts([3000, INTERNAL_VNC_PORT, INTERNAL_TTYD_PORT, 4000])).toEqual([
      3000, 4000,
    ]);
  });

  it("deduplicates before applying the tunnel limit", () => {
    expect(resolveTunnelPorts([3000, 3000, 4000])).toEqual([3000, 4000]);
  });
});

describe("resolveSandboxPortPlan", () => {
  it("resolves enabled defaults and excludes their ports from generic tunnels", () => {
    expect(
      resolveSandboxPortPlan(
        { codeServer: true, terminal: true, vnc: false },
        { tunnelPorts: [8080, 7680, 3000] }
      )
    ).toEqual({
      codeServerPort: 8080,
      terminalPort: 7680,
      reservedPorts: [8080, 7680],
      extraTunnelPorts: [3000],
      allExposedPorts: [8080, 7680, 3000],
    });
  });

  it("rejects collisions between configured and default enabled service ports", () => {
    expect(() =>
      resolveSandboxPortPlan(
        { codeServer: true, terminal: true, vnc: false },
        { terminalEnabled: true, terminalPort: 8080 }
      )
    ).toThrow("Sandbox port 8080 is assigned to more than one enabled service");
  });
});
