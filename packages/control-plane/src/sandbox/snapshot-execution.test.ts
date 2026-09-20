import { describe, expect, it } from "vitest";
import { snapshotExecutionIssue } from "./snapshot-execution";
import type { SessionSandboxExecution } from "@open-inspect/shared/types/sandbox-execution";

const docker: SessionSandboxExecution = {
  profile: "docker-v1",
  provider: "modal",
  cpuCores: 2,
  memoryMib: 4096,
};
describe("snapshot execution compatibility", () => {
  it("does not accept the preservation-only runtime as a Docker-capable snapshot", () => {
    expect(snapshotExecutionIssue(docker, "docker-v1", "v71-final-sandbox-preservation")).toBe(
      "runtime_incompatible"
    );
    expect(
      snapshotExecutionIssue({ profile: "default" }, null, "v71-final-sandbox-preservation")
    ).toBeNull();
  });
  it("never interprets an unlabelled legacy snapshot as a Docker filesystem", () => {
    expect(snapshotExecutionIssue(docker, null, "v72-modal-vm-docker")).toBe("profile_mismatch");
    expect(snapshotExecutionIssue({ profile: "default" }, null, "v70-legacy")).toBeNull();
  });
  it("fails closed for unknown profiles and incompatible Docker runtimes", () => {
    expect(snapshotExecutionIssue(docker, "docker-v2", "v71-test")).toBe(
      "invalid_snapshot_metadata"
    );
    expect(snapshotExecutionIssue(docker, "docker-v1", "v70-test")).toBe("runtime_incompatible");
    expect(snapshotExecutionIssue(docker, "docker-v1", null)).toBe("runtime_incompatible");
    expect(snapshotExecutionIssue(docker, "docker-v1", "v72-test")).toBeNull();
  });
});
