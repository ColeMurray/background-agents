import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  transition: vi.fn(),
  dispatch: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("./ingress-authority", async (importOriginal) => ({
  ...(await importOriginal()),
  claimSlackIngress: mocks.claim,
  transitionSlackIngress: mocks.transition,
  getSlackIngress: vi.fn(),
}));
vi.mock("./events/dispatcher", () => ({ handleSlackEvent: mocks.dispatch }));
vi.mock("./activity-status", () => ({ setAssistantThreadStatusBestEffort: mocks.activity }));
import { consumeSlackIngress, processSlackIngressJob } from "./ingress-consumer";

const job = { version: 1 as const, receiptId: "r1", eventId: "Ev1", admittedAt: 1 };
const payload = JSON.stringify({
  type: "event_callback",
  event_id: "Ev1",
  event: { type: "app_mention", channel: "C1", ts: "1.2", user: "U1", text: "hi" },
});
describe("durable Slack ingress consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue({ id: "r1", state: "processing", payload_json: payload });
    mocks.transition.mockResolvedValue(true);
    mocks.dispatch.mockResolvedValue(undefined);
    mocks.activity.mockResolvedValue(undefined);
  });
  it("lets only the authority claim winner dispatch and marks it complete", async () => {
    mocks.claim
      .mockResolvedValueOnce({ id: "r1", state: "processing", payload_json: payload })
      .mockResolvedValueOnce(null);
    expect(
      await Promise.all([
        processSlackIngressJob({} as never, job, "fast"),
        processSlackIngressJob({} as never, job, "queue"),
      ])
    ).toEqual(["processed", "duplicate"]);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.activity).toHaveBeenCalledOnce();
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.anything(),
      "r1",
      "fast",
      "processing",
      "completed"
    );
  });
  it("records bounded failure without logging or returning event content", async () => {
    mocks.dispatch.mockRejectedValue(new Error("boom"));
    await expect(processSlackIngressJob({} as never, job, "worker")).rejects.toThrow("boom");
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.anything(),
      "r1",
      "worker",
      "processing",
      "admitted",
      "dispatch_failed"
    );
  });
  it("acknowledges duplicate DLQ deliveries and emits metadata-only observability", async () => {
    mocks.claim.mockResolvedValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = { body: job, ack: vi.fn(), retry: vi.fn() };
    await consumeSlackIngress(
      { queue: "slack-ingress-dlq", messages: [message] } as never,
      {} as never
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(
        ([line]) => String(line).includes("slack.ingress.dlq") && !String(line).includes("hi")
      )
    ).toBe(true);
  });
  it("terminalizes an exhausted DLQ dispatch instead of looping", async () => {
    mocks.dispatch.mockRejectedValue(new Error("still unavailable"));
    const message = { body: job, ack: vi.fn(), retry: vi.fn() };
    await consumeSlackIngress(
      { queue: "slack-ingress-dlq", messages: [message] } as never,
      {} as never
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(mocks.transition).toHaveBeenCalledWith(
      expect.anything(),
      "r1",
      expect.any(String),
      "processing",
      "failed",
      "dispatch_failed"
    );
  });
});
