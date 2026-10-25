import { describe, expect, it, vi } from "vitest";
import { resolveCallbackRoute } from "./callback-routes";
import type { CallbackPublicationScope } from "../authorization/callback-publication-scope";

describe("callback routes", () => {
  it.each([
    "web",
    "extension",
    "github",
    "agent",
    "future-source",
    "__proto__",
    "constructor",
    null,
  ])("safely falls back to the legacy Slack route for %s", (source) => {
    expect(resolveCallbackRoute(source)).toBe(resolveCallbackRoute("slack"));
  });

  it("declares Slack's argument default independently of schema presence", () => {
    expect(resolveCallbackRoute("slack").defaultArgs).toEqual({});
    expect(resolveCallbackRoute("linear").defaultArgs).toBeUndefined();
    expect(resolveCallbackRoute("discord").defaultArgs).toBeUndefined();
  });

  it.each(["linear", "discord"])("requires tool arguments for %s", (source) => {
    const route = resolveCallbackRoute(source);
    expect(route.toolCallSchema).toBeDefined();
    expect(route.toolCallSchema?.safeParse({ tool: "bash", callId: "call-1" }).success).toBe(false);
  });

  it("keeps Linear ungated with no denial callback", async () => {
    const scope: CallbackPublicationScope = {
      getSession: vi.fn(),
      getChannelBinding: vi.fn(),
    };
    const route = resolveCallbackRoute("linear");
    expect(await route.postGate(scope, "session-1", {})).toBeNull();
    expect(scope.getSession).not.toHaveBeenCalled();
    expect(scope.getChannelBinding).not.toHaveBeenCalled();
    expect(route.denial).toBeUndefined();
  });

  it("builds Discord stopped notifications from an explicit coordinate allowlist", () => {
    const notification = resolveCallbackRoute("discord").denial?.notification(
      "session-1",
      {
        channelId: "chan-1",
        threadId: "thread-1",
        statusMessage: { id: "status-1", startedAt: 10, result: "private result" },
        channel: "C123",
        threadTs: "1.2",
        userId: "private-user",
        repoFullName: "private/repo",
        model: "private-model",
        error: "private error",
        tool: "private-tool",
        args: { command: "private command" },
      },
      20
    );
    expect(notification).toEqual({
      path: "/callbacks/publication_stopped",
      payload: {
        kind: "discord.publication_stopped",
        sessionId: "session-1",
        timestamp: 20,
        context: {
          channelId: "chan-1",
          threadId: "thread-1",
          statusMessage: { id: "status-1", startedAt: 10 },
        },
      },
    });
  });

  it.each([null, [], {}, { channelId: "" }, { channelId: "c", statusMessage: {} }])(
    "does not invent Discord coordinates for invalid context: %j",
    (context) => {
      expect(
        resolveCallbackRoute("discord").denial?.notification("session-1", context, 20)
      ).toBeNull();
    }
  );

  it("does not mistake Slack coordinates for Discord coordinates", () => {
    expect(
      resolveCallbackRoute("discord").denial?.notification(
        "session-1",
        {
          channel: "C123",
          threadTs: "1.2",
        },
        20
      )
    ).toBeNull();
  });
});
