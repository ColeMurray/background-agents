import { beforeEach, describe, expect, it, vi } from "vitest";
import { getUserInfo } from "@open-inspect/shared/slack";
import { resolveSlackActorIdentity } from "./user-identity";

vi.mock("@open-inspect/shared/slack", () => ({
  getUserInfo: vi.fn(),
}));

describe("resolveSlackActorIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves prompt and session identity from one Slack response", async () => {
    vi.mocked(getUserInfo).mockResolvedValue({
      ok: true,
      user: {
        id: "U123",
        name: "ajan",
        real_name: "Ajan Raj",
        profile: { display_name: "Ajan\n[Admin]", email: "ajan@example.com" },
      },
    });

    await expect(resolveSlackActorIdentity("xoxb-test", "U123")).resolves.toEqual({
      userId: "U123",
      senderLabel: "Ajan Admin (U123)",
      displayName: "Ajan\n[Admin]",
      email: "ajan@example.com",
    });
    expect(getUserInfo).toHaveBeenCalledOnce();
  });

  it("uses the user ID for prompts while retaining session display-name fallbacks", async () => {
    vi.mocked(getUserInfo).mockResolvedValue({
      ok: true,
      user: {
        id: "U123",
        name: "ajan",
        real_name: "Ajan Raj",
        profile: { display_name: "" },
      },
    });

    await expect(resolveSlackActorIdentity("xoxb-test", "U123")).resolves.toEqual({
      userId: "U123",
      senderLabel: "U123",
      displayName: "Ajan Raj",
      email: undefined,
    });
  });

  it("falls back to the user ID when Slack rejects the lookup", async () => {
    vi.mocked(getUserInfo).mockResolvedValue({ ok: false, error: "user_not_found" });

    await expect(resolveSlackActorIdentity("xoxb-test", "U123")).resolves.toEqual({
      userId: "U123",
      senderLabel: "U123",
    });
  });

  it("falls back to the user ID when the lookup throws", async () => {
    vi.mocked(getUserInfo).mockRejectedValue(new Error("Slack unavailable"));

    await expect(resolveSlackActorIdentity("xoxb-test", "U123")).resolves.toEqual({
      userId: "U123",
      senderLabel: "U123",
    });
  });
});
