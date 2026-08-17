import { describe, expect, it, vi } from "vitest";
import { SessionMessengerImpl } from "./messenger";
import type { SessionConnections } from "./connections";

function harness() {
  const connections = {
    registerBrowser: vi.fn(async () => {}),
    registerSandbox: vi.fn(async () => {}),
    sendToSandbox: vi.fn(async () => {}),
    broadcastToBrowsers: vi.fn(async () => {}),
    disconnectSandbox: vi.fn(async () => {}),
    listParticipants: vi.fn(async () => []),
  } satisfies SessionConnections;
  return { messenger: new SessionMessengerImpl(connections), connections };
}

describe("SessionMessengerImpl", () => {
  it("broadcasts to every authenticated client socket", () => {
    const { messenger, connections } = harness();
    const message = { type: "diff_state_changed", revisionId: "r1", updatedAt: 1 } as const;

    messenger.broadcast(message);

    expect(connections.broadcastToBrowsers).toHaveBeenCalledWith(message);
  });

  it("sends a command to the connected sandbox socket", async () => {
    const { messenger, connections } = harness();

    await messenger.sendToSandbox({ type: "refresh_diff" });
    expect(connections.sendToSandbox).toHaveBeenCalledWith({ type: "refresh_diff" });
  });

  it("emits prompt queue updates to every authenticated client", () => {
    const { messenger, connections } = harness();
    const message = { type: "prompt_queue_updated", promptQueue: [] } satisfies Parameters<
      typeof messenger.broadcast
    >[0];

    messenger.broadcast(message);

    expect(connections.broadcastToBrowsers).toHaveBeenCalledWith(message);
  });

  it("reports failure when no sandbox is connected", async () => {
    const { messenger, connections } = harness();
    connections.sendToSandbox.mockRejectedValue(new Error("No sandbox connected"));

    await expect(messenger.sendToSandbox({ type: "refresh_diff" })).rejects.toThrow(
      "No sandbox connected"
    );
  });
});
