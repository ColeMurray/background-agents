import { describe, expect, it } from "vitest";
import { resolveServicePorts } from "./port-resolution";

describe("resolveServicePorts", () => {
  it("resolves the default and configured noVNC port", () => {
    expect(resolveServicePorts(undefined).vncPort).toBe(6080);
    expect(resolveServicePorts({ vncPort: 6099 }).vncPort).toBe(6099);
  });
});
