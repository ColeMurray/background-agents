import { describe, expect, it } from "vitest";
import {
  assertDockerSandboxAdmitted,
  DOCKER_SANDBOX_DEFAULT_CPU_CORES,
  DOCKER_SANDBOX_DEFAULT_MEMORY_MIB,
  DockerSandboxAdmissionError,
  freezeDockerSandboxSettings,
  isDockerSandbox,
  resolveDockerSandboxAdmission,
  sandboxArtifactVariantFor,
} from "./modal-docker";

describe("resolveDockerSandboxAdmission", () => {
  it.each(["daytona", "vercel", "opencomputer", "e2b"])(
    "never admits Docker on %s, even with the gate open",
    (provider) => {
      expect(
        resolveDockerSandboxAdmission({
          SANDBOX_PROVIDER: provider,
          ENABLE_MODAL_VM_SANDBOXES: "true",
        })
      ).toMatchObject({ admitted: false, reason: "docker_not_allowed" });
    }
  );

  it.each([undefined, "", "false", "0", "yes"])("keeps Modal closed for flag %p", (flag) => {
    expect(
      resolveDockerSandboxAdmission({ SANDBOX_PROVIDER: "modal", ENABLE_MODAL_VM_SANDBOXES: flag })
    ).toMatchObject({ admitted: false, reason: "docker_not_available" });
  });

  it.each(["true", "1", " TRUE "])("admits Modal for flag %p", (flag) => {
    expect(
      resolveDockerSandboxAdmission({
        SANDBOX_PROVIDER: undefined,
        ENABLE_MODAL_VM_SANDBOXES: flag,
      })
    ).toEqual({ admitted: true });
  });
});

describe("assertDockerSandboxAdmitted", () => {
  const closed = { SANDBOX_PROVIDER: "modal", ENABLE_MODAL_VM_SANDBOXES: "false" };

  it("ignores standard sessions regardless of the gate", () => {
    expect(() => assertDockerSandboxAdmitted(closed, {})).not.toThrow();
    expect(() => assertDockerSandboxAdmitted(closed, { dockerEnabled: false })).not.toThrow();
    expect(() => assertDockerSandboxAdmitted(closed, undefined)).not.toThrow();
  });

  it("rejects a Docker session with the closed reason", () => {
    expect(() => assertDockerSandboxAdmitted(closed, { dockerEnabled: true })).toThrow(
      DockerSandboxAdmissionError
    );
    try {
      assertDockerSandboxAdmitted(closed, { dockerEnabled: true });
    } catch (e) {
      expect((e as DockerSandboxAdmissionError).reason).toBe("docker_not_available");
    }
  });
});

describe("freezeDockerSandboxSettings", () => {
  it("represents the default as absence and leaves other settings untouched", () => {
    expect(freezeDockerSandboxSettings({ tunnelPorts: [3000] })).toEqual({ tunnelPorts: [3000] });
    expect(freezeDockerSandboxSettings({ dockerEnabled: false, cpuCores: null })).toEqual({
      cpuCores: null,
    });
  });

  it("freezes Docker with default resources when none are configured", () => {
    expect(freezeDockerSandboxSettings({ dockerEnabled: true, tunnelPorts: [5432] })).toEqual({
      dockerEnabled: true,
      tunnelPorts: [5432],
      cpuCores: DOCKER_SANDBOX_DEFAULT_CPU_CORES,
      memoryMib: DOCKER_SANDBOX_DEFAULT_MEMORY_MIB,
    });
  });

  it("keeps configured resources and treats an explicit null as unset", () => {
    expect(
      freezeDockerSandboxSettings({ dockerEnabled: true, cpuCores: 4, memoryMib: null })
    ).toEqual({ dockerEnabled: true, cpuCores: 4, memoryMib: DOCKER_SANDBOX_DEFAULT_MEMORY_MIB });
  });

  it("lets a per-session override beat the configured value in both directions", () => {
    expect(freezeDockerSandboxSettings({ dockerEnabled: true }, false)).toEqual({});
    expect(freezeDockerSandboxSettings({ dockerEnabled: false }, true)).toMatchObject({
      dockerEnabled: true,
    });
    expect(freezeDockerSandboxSettings({}, true)).toMatchObject({ dockerEnabled: true });
  });
});

describe("artifact variant", () => {
  it("derives the variant from the frozen choice only", () => {
    expect(sandboxArtifactVariantFor(undefined)).toBe("default");
    expect(sandboxArtifactVariantFor({ dockerEnabled: false })).toBe("default");
    expect(sandboxArtifactVariantFor({ dockerEnabled: true })).toBe("modal-docker-v1");
    expect(isDockerSandbox({ dockerEnabled: true })).toBe(true);
    expect(isDockerSandbox({})).toBe(false);
  });
});
