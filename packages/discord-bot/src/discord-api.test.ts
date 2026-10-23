import { afterEach, describe, expect, it, vi } from "vitest";
import { editOriginalResponse } from "./discord-api";

afterEach(() => vi.unstubAllGlobals());

describe("Discord API errors", () => {
  it("never include the interaction token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 }))
    );

    const error: unknown = await editOriginalResponse("app-1", "secret-token", {
      content: "hi",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain("secret-token");
    expect((error as Error).message).not.toContain("secret-token");
    expect((error as Error).message).toBe(
      "Discord API /webhooks/app-1/<token>/messages/@original failed with 503"
    );
  });
});
