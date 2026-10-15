import { Sandbox } from "@opencomputer/sdk";
import { expect, it, onTestFinished } from "vitest";
import { OpenComputerRestClient } from "./opencomputer-rest-client";
import { OpenComputerSandboxProvider } from "./providers/opencomputer-provider";
import { cleanupOpenComputerCanary } from "../../test/helpers/opencomputer-canary";

// Explicit opt-in: this allocates paid provider resources and needs a rebuilt
// managed template. No model credentials or real control-plane connection are used.
it.skipIf(process.env.OPENCOMPUTER_RUN_LIVE_TESTS !== "1")(
  "preserves workspace and home sentinels across OpenComputer checkpoint, shutdown and restore",
  async () => {
    const apiKey = process.env.OPENCOMPUTER_API_KEY;
    const template = process.env.OPENCOMPUTER_TEMPLATE;
    if (!apiKey || !template)
      throw new Error("OPENCOMPUTER_API_KEY and OPENCOMPUTER_TEMPLATE are required");
    const apiUrl = process.env.OPENCOMPUTER_API_URL ?? "https://app.opencomputer.dev/api";
    const client = new OpenComputerRestClient({ apiUrl, apiKey, template });
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: crypto.randomUUID(),
    });
    const sessionId = `canary-${crypto.randomUUID()}`;
    const launch = {
      sessionId,
      sandboxId: sessionId,
      repoOwner: "",
      repoName: "",
      controlPlaneUrl: "http://127.0.0.1:9",
      sandboxAuthToken: crypto.randomUUID(),
      harness: "opencode" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      branch: "main",
    };
    const ids: string[] = [];
    const paths = [`/workspace/${sessionId}`, `/home/sandbox/${sessionId}`];
    const write = paths.map((path) => `printf '%s' '${sessionId}' > '${path}'`).join(" && ");
    const verify = paths.map((path) => `test "$(cat '${path}')" = '${sessionId}'`).join(" && ");
    const exec = async (id: string, command: string) => {
      const sandbox = await Sandbox.connect(id, { apiUrl, apiKey });
      const result = await sandbox.exec.run(command, { timeout: 60, timeoutMs: 90_000 });
      expect(result.exitCode, result.stderr).toBe(0);
    };
    onTestFinished(() => cleanupOpenComputerCanary(client, provider, ids, sessionId), 330_000);
    const created = await provider.createSandbox(launch);
    expect(created.providerObjectId).toBeTruthy();
    ids.push(created.providerObjectId!);
    expect(created.lifetime).toMatchObject({ kind: "finite", source: "provider" });
    await exec(ids[0], "/opt/openinspect/python/bin/python /app/verify/smoke_test.py verify");
    await exec(ids[0], write);
    const checkpoint = await provider.takeSnapshot({
      sessionId,
      providerObjectId: ids[0],
      reason: "shutdown_canary",
    });
    const checkpointId = checkpoint.imageId;
    expect(checkpoint.success, checkpoint.error).toBe(true);
    expect(checkpointId).toBeTruthy();
    expect(
      await provider.stopSandbox({
        sessionId,
        providerObjectId: ids[0],
        reason: "shutdown_canary",
        intent: "preserve",
      })
    ).toEqual({ success: true });
    const restored = await provider.restoreFromSnapshot({
      ...launch,
      sandboxId: `${sessionId}-restored`,
      snapshotImageId: checkpointId!,
    });
    expect(restored.success, restored.error).toBe(true);
    expect(restored.providerObjectId).toBeTruthy();
    ids.push(restored.providerObjectId!);
    await exec(ids[1], verify);
    const resumed = await provider.resumeSandbox({ ...launch, providerObjectId: ids[0] });
    expect(resumed.success, resumed.error).toBe(true);
    await exec(ids[0], verify);
  },
  600_000
);
