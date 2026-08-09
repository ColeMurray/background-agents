import { DEFAULT_VNC_PORT, INTERNAL_VNC_PORT } from "@open-inspect/shared/types/integrations";
import { describe, expect, it } from "vitest";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";

describe("resolveServicePorts", () => {
  it("resolves the default and configured noVNC port", () => {
    expect(resolveServicePorts(undefined).vncPort).toBe(DEFAULT_VNC_PORT);
    expect(resolveServicePorts({ vncPort: 6099 }).vncPort).toBe(6099);
  });
});

describe("resolveTunnelPorts", () => {
  it("defensively excludes the internal raw VNC port", () => {
    expect(resolveTunnelPorts([3000, INTERNAL_VNC_PORT, 4000])).toEqual([3000, 4000]);
  });
});
