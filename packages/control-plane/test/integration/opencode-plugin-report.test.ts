import type { OpencodePluginReport } from "@open-inspect/shared/types/sandbox-events";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { expect, it } from "vitest";
import { initSession, queryDO, seedEvents, waitForSandboxStatus } from "./helpers";
import { componentsOf, runInSessionDO } from "./session-do-access";

it("persists the latest plugin report outside replay pagination and resets it on replacement", async () => {
  const { stub } = await initSession();
  await waitForSandboxStatus(stub, "failed");
  await queryDO(
    stub,
    "UPDATE sandbox SET status = 'ready', modal_sandbox_id = 'sandbox-plugins', fenced = 0"
  );
  const report: OpencodePluginReport = {
    type: "opencode_plugins",
    sandboxId: "sandbox-plugins",
    timestamp: 1,
    bootSeq: 12,
    plugins: [{ spec: "audit@1.0.0", status: "loaded" }],
  };
  const postReport = (body: OpencodePluginReport) =>
    stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const snapshot = async () =>
    (await stub.fetch("http://internal/internal/snapshot")).json<SessionSnapshot>();
  expect((await postReport(report)).status).toBe(200);
  expect((await snapshot()).session.opencodePlugins).toEqual(report);
  // A replayed or older report must not replace current state or duplicate timeline entries.
  await postReport(report);
  await postReport({ ...report, timestamp: 2, bootSeq: 11, plugins: [] });
  expect(
    await queryDO(stub, "SELECT type FROM events WHERE type = 'opencode_plugins'")
  ).toHaveLength(1);
  await seedEvents(
    stub,
    Array.from({ length: 501 }, (_, i) => ({
      id: `plugin-token-${i}`,
      type: "token",
      createdAt: Date.now() + i,
      data: JSON.stringify({
        type: "token",
        sandboxId: report.sandboxId,
        timestamp: i + 3,
        messageId: "plugin-message",
        content: "x",
      }),
    }))
  );
  const replay = await snapshot();
  expect(replay.timeline.events).toHaveLength(500);
  expect(replay.timeline.hasMore).toBe(true);
  expect(replay.timeline.events.some(({ event }) => event.type === "opencode_plugins")).toBe(false);
  expect(replay.session.opencodePlugins).toEqual(report);
  await runInSessionDO(stub, (instance) => {
    componentsOf(instance).sandboxRepository.updateSandboxForSpawn({
      status: "spawning",
      createdAt: Date.now(),
      modalSandboxId: "replacement-plugins",
    });
  });
  expect((await snapshot()).session.opencodePlugins).toBeNull();
  // A late report from the replaced sandbox cannot reintroduce its configuration.
  await postReport({ ...report, bootSeq: 13, timestamp: 5 });
  expect((await snapshot()).session.opencodePlugins).toBeNull();
  const replacement = { ...report, sandboxId: "replacement-plugins", bootSeq: 1, plugins: [] };
  await postReport(replacement);
  expect((await snapshot()).session.opencodePlugins).toEqual(replacement);
  await runInSessionDO(stub, (instance) => {
    componentsOf(instance).sandboxRepository.updateSandboxForResume({
      status: "connecting",
      createdAt: Date.now(),
    });
  });
  expect((await snapshot()).session.opencodePlugins).toBeNull();
});
