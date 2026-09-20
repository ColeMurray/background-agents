import { describe, expect, it } from "vitest";
import {
  daytonaBuildConfigurationKey,
  daytonaCreateSource,
  requireDaytonaBaseImage,
  resolveDaytonaResources,
} from "./daytona-resources";

const IMAGE = `ghcr.io/acme/open-inspect@sha256:${"a".repeat(64)}`;

describe("Daytona OCI resources", () => {
  it.each([
    [undefined, { cpu: 1, memory: 2 }],
    [
      { cpuCores: null, memoryMib: null },
      { cpu: 1, memory: 2 },
    ],
    [
      { cpuCores: 0.5, memoryMib: 1536 },
      { cpu: 1, memory: 2 },
    ],
    [
      { cpuCores: 2.1, memoryMib: 2049 },
      { cpu: 3, memory: 3 },
    ],
  ])("normalizes settings upward", (settings, expected) => {
    expect(resolveDaytonaResources(settings)).toEqual(expected);
  });

  it.each([
    { cpuCores: Number.POSITIVE_INFINITY },
    { cpuCores: Number.MAX_VALUE },
    { memoryMib: Number.MAX_VALUE },
    { memoryMib: 1.5 },
  ])("rejects unsafe settings", (settings) => {
    expect(() => resolveDaytonaResources(settings)).toThrow();
  });

  it("requires an explicit registry and immutable lowercase digest", () => {
    expect(requireDaytonaBaseImage(IMAGE)).toBe(IMAGE);
    for (const invalid of [
      `acme/image@sha256:${"a".repeat(64)}`,
      "ghcr.io/acme/image:latest",
      `${IMAGE}\nRUN echo pwned`,
      `GHCR.io/acme/image@sha256:${"a".repeat(64)}`,
    ]) {
      expect(() => requireDaytonaBaseImage(invalid)).toThrow();
    }
  });

  it("builds the exact SDK-compatible REST image source", () => {
    expect(daytonaCreateSource({ image: IMAGE, resources: { cpu: 2, memory: 4 } })).toEqual({
      buildInfo: { dockerfileContent: `FROM ${IMAGE}` },
      cpu: 2,
      memory: 4,
    });
    expect(daytonaCreateSource({ snapshot: "snap-1" })).toEqual({ snapshot: "snap-1" });
  });

  it("keys the exact digest and normalized allocation", () => {
    expect(daytonaBuildConfigurationKey(IMAGE, { cpu: 2, memory: 4 })).toBe(
      `daytona-oci-v1:${IMAGE}:cpu=2:memory=4`
    );
  });
});
