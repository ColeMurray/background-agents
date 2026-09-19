import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { deliverPrompt } from "./prompt-delivery";
import { sendPrompt } from "./control-plane-client";
import {
  notifyDroppedAttachments,
  uploadPreparedAttachments,
  type PreparedImageAttachments,
} from "../attachments";

vi.mock("../attachments", () => ({
  uploadPreparedAttachments: vi.fn(),
  notifyDroppedAttachments: vi.fn(async () => {}),
}));

vi.mock("./control-plane-client", () => ({
  sendPrompt: vi.fn(),
}));

const env = { LOG_LEVEL: "error" } as Env;

const emptyPrepared: PreparedImageAttachments = { files: [], dropped: [] };

function options(overrides: Partial<Parameters<typeof deliverPrompt>[1]> = {}) {
  return {
    sessionId: "session-1",
    content: "Fix it",
    authorId: "slack:U123",
    attachments: emptyPrepared,
    imageOnly: false,
    channel: "C123",
    threadTs: "111.222",
    traceId: "trace-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uploadPreparedAttachments).mockResolvedValue({
    references: [],
    dropped: [],
    sessionMissing: false,
  });
  vi.mocked(sendPrompt).mockResolvedValue({ ok: true, data: { messageId: "message-1" } });
});

describe("deliverPrompt", () => {
  it("uploads attachments, sends the prompt with references, then notifies drops", async () => {
    vi.mocked(uploadPreparedAttachments).mockResolvedValue({
      references: [{ attachmentId: "att-1", name: "screenshot.png" }],
      dropped: ["too_large"],
      sessionMissing: false,
    });

    const result = await deliverPrompt(env, options({ clientRequestId: "request-1" }));

    expect(result).toEqual({ ok: true, data: { messageId: "message-1" } });
    expect(sendPrompt).toHaveBeenCalledWith(env, {
      sessionId: "session-1",
      content: "Fix it",
      authorId: "slack:U123",
      callbackContext: undefined,
      attachments: [{ attachmentId: "att-1", name: "screenshot.png" }],
      traceId: "trace-1",
      clientRequestId: "request-1",
    });
    expect(uploadPreparedAttachments).toHaveBeenCalledWith(
      env,
      "session-1",
      emptyPrepared,
      "slack:U123",
      "trace-1",
      "request-1"
    );
    expect(notifyDroppedAttachments).toHaveBeenCalledWith(
      env,
      "C123",
      "111.222",
      expect.objectContaining({ dropped: ["too_large"] }),
      { traceId: "trace-1" }
    );
    const sendOrder = vi.mocked(sendPrompt).mock.invocationCallOrder[0]!;
    const notifyOrder = vi.mocked(notifyDroppedAttachments).mock.invocationCallOrder[0]!;
    expect(sendOrder).toBeLessThan(notifyOrder);
  });

  it("persists uploaded references before sending an idempotent prompt", async () => {
    const references = [{ attachmentId: "att-1", name: "screenshot.png" }];
    const onAttachmentsPrepared = vi.fn(async () => {});
    vi.mocked(uploadPreparedAttachments).mockResolvedValue({
      references,
      dropped: [],
      sessionMissing: false,
    });

    await deliverPrompt(env, options({ onAttachmentsPrepared }));

    expect(onAttachmentsPrepared).toHaveBeenCalledWith(references);
    expect(onAttachmentsPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendPrompt).mock.invocationCallOrder[0]!
    );
  });

  it("replays persisted attachment references when upload outcomes change", async () => {
    const references = [{ attachmentId: "att-original", name: "screenshot.png" }];
    const onAttachmentsPrepared = vi.fn(async () => {});
    vi.mocked(uploadPreparedAttachments).mockResolvedValue({
      references: [{ attachmentId: "att-new", name: "screenshot.png" }],
      dropped: [],
      sessionMissing: false,
    });

    await deliverPrompt(env, options({ attachmentReferences: references, onAttachmentsPrepared }));

    expect(onAttachmentsPrepared).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ attachments: references })
    );
  });

  it("does not notify drops when the prompt send fails", async () => {
    vi.mocked(uploadPreparedAttachments).mockResolvedValue({
      references: [],
      dropped: ["download_failed"],
      sessionMissing: false,
    });
    vi.mocked(sendPrompt).mockResolvedValue({ ok: false, reason: "stale" });

    const result = await deliverPrompt(env, options());

    expect(result).toEqual({ ok: false, reason: "stale" });
    expect(notifyDroppedAttachments).not.toHaveBeenCalled();
  });

  it("sends no prompt for an image-only request that lost every image", async () => {
    vi.mocked(uploadPreparedAttachments).mockResolvedValue({
      references: [],
      dropped: ["upload_rejected"],
      sessionMissing: false,
    });

    const result = await deliverPrompt(env, options({ imageOnly: true }));

    expect(result).toEqual({ ok: false, reason: "no_images_delivered" });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(notifyDroppedAttachments).toHaveBeenCalledWith(
      env,
      "C123",
      "111.222",
      expect.objectContaining({ dropped: ["upload_rejected"] }),
      { traceId: "trace-1", nothingSent: true }
    );
  });

  it("surfaces staleness instead of a drop notice when the session is gone", async () => {
    vi.mocked(uploadPreparedAttachments).mockResolvedValue({
      references: [],
      dropped: ["upload_rejected"],
      sessionMissing: true,
    });

    const result = await deliverPrompt(env, options({ imageOnly: true }));

    expect(result).toEqual({ ok: false, reason: "stale" });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(notifyDroppedAttachments).not.toHaveBeenCalled();
  });

  it("still sends a text prompt when images dropped but user text exists", async () => {
    vi.mocked(uploadPreparedAttachments).mockResolvedValue({
      references: [],
      dropped: ["download_failed"],
      sessionMissing: false,
    });

    const result = await deliverPrompt(env, options({ imageOnly: false }));

    expect(result.ok).toBe(true);
    expect(sendPrompt).toHaveBeenCalled();
  });
});
