import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutomationStore,
  type AutomationInvocationRow,
  type EnrichedRunRow,
} from "../db/automation-store";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { createLogger } from "../logger";
import type { MessageRepository } from "./message-repository";
import { SessionSnapshotReader, type SessionSnapshotReaderDeps } from "./snapshot-reader";

function enrichmentReader(
  origin: ReturnType<MessageRepository["getSlackThreadOrigin"]> = {
    source: "slack",
    channelId: "C123",
  }
) {
  const log = createLogger("snapshot-reader-test");
  // These tests exercise only the asynchronous enrichment dependencies.
  const reader = new SessionSnapshotReader({
    sessionCoreRepository: {
      getSession: () => ({
        id: "internal-session",
        session_name: "public-session",
        environment_id: null,
      }),
    },
    messageRepository: { getSlackThreadOrigin: () => origin },
    db: {},
    log,
  } as unknown as SessionSnapshotReaderDeps);
  return { reader, log };
}

afterEach(() => vi.restoreAllMocks());

describe("Slack thread snapshot enrichment", () => {
  it("looks up the current provider-specific binding on every enrichment", async () => {
    const get = vi
      .spyOn(TeamChannelBindingStore.prototype, "get")
      .mockResolvedValueOnce({
        provider: "slack",
        externalId: "C123",
        teamId: "team-1",
        kind: "source",
      })
      .mockResolvedValueOnce({
        provider: "slack",
        externalId: "C123",
        teamId: "team-2",
        kind: "primary",
      })
      .mockResolvedValueOnce(null);
    const { reader } = enrichmentReader();

    for (const teamId of ["team-1", "team-2", null]) {
      expect(await reader.resolveSessionSnapshotEnrichment()).toEqual({
        environmentId: null,
        environmentName: null,
        slackThread: { channelId: "C123", teamId },
      });
    }
    expect(get.mock.calls).toEqual([
      ["slack", "C123"],
      ["slack", "C123"],
      ["slack", "C123"],
    ]);
  });

  it("does not look up a binding without a validated originating channel", async () => {
    const get = vi.spyOn(TeamChannelBindingStore.prototype, "get");
    const { reader } = enrichmentReader(null);

    expect(await reader.resolveSessionSnapshotEnrichment()).not.toHaveProperty("slackThread");
    expect(get).not.toHaveBeenCalled();
  });

  it("omits metadata rather than inferring an unbound channel on lookup failure", async () => {
    vi.spyOn(TeamChannelBindingStore.prototype, "get").mockRejectedValue(
      new Error("DB unavailable")
    );
    const { reader, log } = enrichmentReader();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(await reader.resolveSessionSnapshotEnrichment()).toEqual({
      environmentId: null,
      environmentName: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      channel_id: "C123",
      error: "DB unavailable",
    });
  });
});

describe("automation Slack thread snapshot enrichment", () => {
  const origin = { source: "automation", automationId: "automation-1", runId: "run-1" } as const;
  const run: EnrichedRunRow = {
    id: "run-1",
    automation_id: "automation-1",
    invocation_id: "invocation-1",
    session_id: "public-session",
    status: "completed",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: 1,
    started_at: 1,
    completed_at: 2,
    execution_deadline_at: null,
    created_at: 1,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    environment_id: null,
    session_title: null,
    artifact_summary: null,
  };
  const invocation: AutomationInvocationRow = {
    id: "invocation-1",
    automation_id: "automation-1",
    source: "event",
    scheduled_at: null,
    trigger_key: "slack:msg:C123:123.456",
    concurrency_key: "slack:C123:123.456",
    trigger_metadata: JSON.stringify({ channel: "C123", messageTs: "123.456" }),
    skip_reason: null,
    failure_counted_at: null,
    created_at: 1,
    updated_at: 1,
  };

  it.each(["team-1", null])(
    "resolves a Slack-triggered run and its current binding (%s)",
    async (teamId) => {
      const getRun = vi.spyOn(AutomationStore.prototype, "getRunById").mockResolvedValue(run);
      const getInvocation = vi
        .spyOn(AutomationStore.prototype, "getInvocationById")
        .mockResolvedValue(invocation);
      const getBinding = vi
        .spyOn(TeamChannelBindingStore.prototype, "get")
        .mockResolvedValue(
          teamId ? { provider: "slack", externalId: "C123", teamId, kind: "source" } : null
        );
      const { reader } = enrichmentReader(origin);

      expect(await reader.resolveSessionSnapshotEnrichment()).toEqual({
        environmentId: null,
        environmentName: null,
        slackThread: { channelId: "C123", teamId },
      });
      expect(getRun).toHaveBeenCalledWith("automation-1", "run-1");
      expect(getInvocation).toHaveBeenCalledWith("invocation-1");
      expect(getBinding).toHaveBeenCalledWith("slack", "C123");
    }
  );

  it.each([
    null,
    { ...run, session_id: null },
    { ...run, session_id: "internal-session" },
    { ...run, session_id: "another-public-session" },
  ])(
    "rejects a missing run or one not bound to the current public session (%j)",
    async (runRow) => {
      vi.spyOn(AutomationStore.prototype, "getRunById").mockResolvedValue(runRow);
      const getInvocation = vi.spyOn(AutomationStore.prototype, "getInvocationById");
      const getBinding = vi.spyOn(TeamChannelBindingStore.prototype, "get");
      const { reader } = enrichmentReader(origin);

      expect(await reader.resolveSessionSnapshotEnrichment()).not.toHaveProperty("slackThread");
      expect(getInvocation).not.toHaveBeenCalled();
      expect(getBinding).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    { ...invocation, trigger_key: "pr:1:opened:abc" },
    { ...invocation, source: "manual" },
    { ...invocation, source: "schedule" },
    { ...invocation, automation_id: "another-automation" },
    { ...invocation, trigger_metadata: null },
    { ...invocation, trigger_metadata: "{invalid-json" },
    { ...invocation, trigger_metadata: JSON.stringify({ channel: "C123" }) },
    { ...invocation, trigger_metadata: JSON.stringify({ channel: "", messageTs: "123.456" }) },
    { ...invocation, trigger_metadata: JSON.stringify({ channel: "   ", messageTs: "123.456" }) },
    { ...invocation, trigger_metadata: JSON.stringify({ channel: "C123", messageTs: "" }) },
    { ...invocation, trigger_metadata: JSON.stringify({ channel: "C456", messageTs: "123.456" }) },
  ] satisfies Array<AutomationInvocationRow | null>)(
    "does not infer Slack provenance from a non-Slack or invalid invocation (%j)",
    async (invocationRow) => {
      vi.spyOn(AutomationStore.prototype, "getRunById").mockResolvedValue(run);
      vi.spyOn(AutomationStore.prototype, "getInvocationById").mockResolvedValue(invocationRow);
      const getBinding = vi.spyOn(TeamChannelBindingStore.prototype, "get");
      const { reader } = enrichmentReader(origin);

      expect(await reader.resolveSessionSnapshotEnrichment()).not.toHaveProperty("slackThread");
      expect(getBinding).not.toHaveBeenCalled();
    }
  );

  it.each(["getRunById", "getInvocationById"] as const)(
    "omits metadata when %s fails rather than inferring an unbound channel",
    async (method) => {
      vi.spyOn(AutomationStore.prototype, "getRunById").mockResolvedValue(run);
      vi.spyOn(AutomationStore.prototype, "getInvocationById").mockResolvedValue(invocation);
      vi.spyOn(AutomationStore.prototype, method).mockRejectedValue(new Error("DB unavailable"));
      const getBinding = vi.spyOn(TeamChannelBindingStore.prototype, "get");
      const { reader, log } = enrichmentReader(origin);
      vi.spyOn(log, "warn").mockImplementation(() => {});

      expect(await reader.resolveSessionSnapshotEnrichment()).not.toHaveProperty("slackThread");
      expect(getBinding).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    }
  );
});
