import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ImageBuildStore } from "../../src/db/image-builds";
import { repoImageBuildScope } from "../../src/image-builds/model";
import { cleanD1Tables } from "./cleanup";
import type { SessionSandboxExecution } from "@open-inspect/shared/types/sandbox-execution";

const docker: SessionSandboxExecution = {
  profile: "docker-v1",
  provider: "modal",
  cpuCores: 2,
  memoryMib: 4096,
};
describe("Modal VM image families (real D1)", () => {
  beforeEach(cleanD1Tables);
  it("never treats a pre-Docker runtime as up to date in the Docker family", async () => {
    const store = new ImageBuildStore(env.DB);
    const scope = repoImageBuildScope("acme", "web");
    for (const [id, sandboxExecution] of [
      ["default", { profile: "default" }],
      ["docker", docker],
    ] as const) {
      expect(
        await store.registerBuild({
          id,
          scope,
          provider: "modal",
          repositoriesFingerprint: "same",
          sandboxExecution,
        })
      ).toBe(true);
      await env.DB.prepare(
        "UPDATE image_builds SET status = 'ready', runtime_version = 'v71-final-sandbox-preservation', provider_image_id = ? WHERE id = ?"
      )
        .bind(`im-${id}`, id)
        .run();
    }
    expect(await store.hasReadyImageForFingerprint(scope, "modal", "same", "default")).toBe(true);
    expect(await store.hasReadyImageForFingerprint(scope, "modal", "same", "docker-v1")).toBe(
      false
    );
  });
  it("retains and selects each family's latest ready image while serializing all builds", async () => {
    const store = new ImageBuildStore(env.DB);
    const scope = repoImageBuildScope("acme", "web");
    const register = (id: string, sandboxExecution: SessionSandboxExecution) =>
      store.registerBuild({
        id,
        scope,
        provider: "modal",
        repositoriesFingerprint: "same",
        sandboxExecution,
      });
    const ready = (id: string) =>
      store.tryMarkImageBuildReady(id, "modal", `im-${id}`, [], "v72-test", 1);
    expect(await register("default-old", { profile: "default" })).toBe(true);
    expect(await register("docker", docker)).toBe(false);
    expect((await ready("default-old")).type).toBe("marked_ready");
    expect(await register("docker", docker)).toBe(true);
    expect(await ready("docker")).toMatchObject({ type: "marked_ready", supersededImages: [] });
    expect((await store.getLatestReadyForSpawn(scope, "modal", "default"))?.id).toBe("default-old");
    expect(
      (await store.getLatestReadyForSpawn(scope, "modal", "docker-v1"))?.sandbox_execution
    ).toBe(JSON.stringify(docker));
    expect(await register("default-new", { profile: "default" })).toBe(true);
    // Strict chronology independent of millisecond clock granularity/id ordering.
    await env.DB.prepare(
      "UPDATE image_builds SET created_at = created_at + 1000 WHERE id = 'default-new'"
    ).run();
    expect(await ready("default-new")).toMatchObject({
      type: "marked_ready",
      supersededImages: [{ imageBuildId: "default-old" }],
    });
    expect((await store.getLatestReadyForSpawn(scope, "modal", "docker-v1"))?.id).toBe("docker");
    expect(await store.hasReadyImageForFingerprint(scope, "modal", "same", "docker-v1")).toBe(true);
  });
});
