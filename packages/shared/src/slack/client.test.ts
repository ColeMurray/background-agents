import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addReaction,
  completeExternalUpload,
  getExternalUploadUrl,
  getChannelInfo,
  getMessageFiles,
  getPermalink,
  getThreadMessages,
  getUserInfo,
  listChannels,
  openView,
  postMessage,
  publishView,
  removeReaction,
  updateMessage,
  uploadToExternalUrl,
} from "./client";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("external file uploads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests an upload URL with filename, length, and alt text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/ticket",
        file_id: "F123",
      })
    );

    const signal = AbortSignal.timeout(1_000);
    const result = await getExternalUploadUrl("xoxb-token", {
      filename: "chart.png",
      length: 1234,
      altText: "Revenue chart",
      signal,
    });

    expect(result).toEqual({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/ticket",
      file_id: "F123",
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://slack.com/api/files.getUploadURLExternal?filename=chart.png&length=1234&alt_txt=Revenue+chart"
    );
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-token");
    expect(init?.signal).toBe(signal);
    expect(init?.body).toBeUndefined();
  });

  it("uploads raw bytes without forwarding Slack authorization", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));
    const body = new Blob(["chart-bytes"], { type: "image/png" });

    const signal = AbortSignal.timeout(1_000);
    const result = await uploadToExternalUrl(
      "https://files.slack.com/upload/v1/ticket",
      body,
      "image/png",
      signal
    );

    expect(result).toEqual({ ok: true });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(body);
    expect(init?.headers).toEqual({ "Content-Type": "image/png" });
    expect(init?.signal).toBe(signal);
  });

  it("normalizes raw upload HTTP and network failures", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockRejectedValueOnce(new Error("offline"));

    await expect(
      uploadToExternalUrl("https://files.slack.com/upload/v1/one", new Blob(["one"]), "image/png")
    ).resolves.toEqual({ ok: false, error: "http_503" });
    await expect(
      uploadToExternalUrl("https://files.slack.com/upload/v1/two", new Blob(["two"]), "image/png")
    ).resolves.toEqual({ ok: false, error: "network_error" });
  });

  it("completes and shares uploads in the parent thread", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, files: [{ id: "F123", title: "Revenue chart" }] })
      );

    const signal = AbortSignal.timeout(1_000);
    const result = await completeExternalUpload("xoxb-token", {
      files: [
        { id: "F123", title: "Revenue chart" },
        { id: "F456", title: "Forecast video" },
      ],
      channelId: "C123",
      threadTs: "111.222",
      signal,
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/files.completeUploadExternal");
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      files: [
        { id: "F123", title: "Revenue chart" },
        { id: "F456", title: "Forecast video" },
      ],
      channel_id: "C123",
      thread_ts: "111.222",
    });
  });

  it("normalizes finalization network failures instead of rejecting", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));

    await expect(
      completeExternalUpload("xoxb-token", {
        files: [{ id: "F123", title: "Revenue chart" }],
        channelId: "C123",
        threadTs: "111.222",
      })
    ).resolves.toEqual({ ok: false, error: "network_error" });
  });
});

describe("postMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts text to a channel and returns the Slack envelope", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1700000000.000100" }));

    const result = await postMessage("xoxb-token", "C123", "hello");

    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1700000000.000100");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("hello");
  });

  it("threads via thread_ts when provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1700000000.000200" }));

    await postMessage("xoxb-token", "C123", "reply text", {
      thread_ts: "1699999999.000100",
    });

    const init = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.thread_ts).toBe("1699999999.000100");
  });

  it("returns Slack's error envelope without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "channel_not_found" })
    );

    const result = await postMessage("xoxb-token", "C404", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("channel_not_found");
  });

  it("on 429 returns ratelimited with retryAfter from header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", {
        status: 429,
        headers: { "Retry-After": "30" },
      })
    );

    const result = await postMessage("xoxb-token", "C123", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ratelimited");
    expect(result.retryAfter).toBe(30);
  });

  it("on 5xx returns a typed error rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal server error", { status: 503 })
    );

    const result = await postMessage("xoxb-token", "C123", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("http_503");
  });

  it("on malformed 200 body returns a typed error rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await postMessage("xoxb-token", "C123", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_response");
  });

  it("on partial Slack envelope returns a typed error rather than asserting it valid", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: false }))
      .mockResolvedValueOnce(jsonResponse({ ts: "1700000000.000100" }));

    await expect(postMessage("xoxb-token", "C123", "hi")).resolves.toEqual({
      ok: false,
      error: "invalid_response",
    });
    await expect(postMessage("xoxb-token", "C123", "hi")).resolves.toEqual({
      ok: false,
      error: "invalid_response",
    });
  });

  it("on fetch network error returns a typed error rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await postMessage("xoxb-token", "C123", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network_error");
  });
});

describe("getChannelInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches channel info via GET with bearer auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        channel: { id: "C123", name: "ops" },
      })
    );

    const result = await getChannelInfo("xoxb-token", "C123");

    expect(result.ok).toBe(true);
    expect(result.channel).toEqual({ id: "C123", name: "ops" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/conversations.info?channel=C123");
    expect(init?.method ?? "GET").toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-token");
  });

  it("returns Slack's error envelope on lookup failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "channel_not_found" })
    );

    const result = await getChannelInfo("xoxb-token", "C404");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("channel_not_found");
  });

  it("on 429 returns ratelimited with retryAfter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", {
        status: 429,
        headers: { "Retry-After": "5" },
      })
    );

    const result = await getChannelInfo("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ratelimited");
    expect(result.retryAfter).toBe(5);
  });

  it("on 5xx returns a typed error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("oops", { status: 500 }));

    const result = await getChannelInfo("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("http_500");
  });
});

describe("getPermalink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a permalink via GET with channel + message_ts query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        channel: "C123",
        permalink: "https://slack.com/archives/C123/p1700000000000100",
      })
    );

    const result = await getPermalink("xoxb-token", "C123", "1700000000.000100");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.permalink).toContain("/archives/C123/p");
    }
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://slack.com/api/chat.getPermalink?channel=C123&message_ts=1700000000.000100"
    );
  });

  it("returns Slack's error envelope when the message is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "message_not_found" })
    );

    const result = await getPermalink("xoxb-token", "C123", "1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("message_not_found");
    }
  });
});

describe("updateMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts channel/ts/text (and optional blocks) to chat.update", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await updateMessage("xoxb-token", "C123", "1700000000.000100", "edited", {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "edited" } }],
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.channel).toBe("C123");
    expect(body.ts).toBe("1700000000.000100");
    expect(body.text).toBe("edited");
    expect(Array.isArray(body.blocks)).toBe(true);
  });

  it("returns Slack's error envelope on edit failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "message_not_found" })
    );

    const result = await updateMessage("xoxb-token", "C123", "1.0", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("message_not_found");
    }
  });
});

describe("addReaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts channel/timestamp/name to reactions.add", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await addReaction("xoxb-token", "C123", "1700000000.000100", "eyes");

    expect(result.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/reactions.add");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.channel).toBe("C123");
    expect(body.timestamp).toBe("1700000000.000100");
    expect(body.name).toBe("eyes");
  });

  it("returns the already_reacted envelope verbatim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "already_reacted" })
    );

    const result = await addReaction("xoxb-token", "C123", "1.0", "eyes");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("already_reacted");
    }
  });
});

describe("removeReaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts channel/timestamp/name to reactions.remove", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await removeReaction("xoxb-token", "C123", "1700000000.000100", "eyes");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/reactions.remove");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.channel).toBe("C123");
    expect(body.timestamp).toBe("1700000000.000100");
    expect(body.name).toBe("eyes");
  });

  it("returns Slack's error envelope on no_reaction", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "no_reaction" })
    );

    const result = await removeReaction("xoxb-token", "C123", "1.0", "eyes");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no_reaction");
    }
  });
});

describe("getThreadMessages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches replies via GET with channel/ts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        messages: [
          { ts: "1.1", text: "first", user: "U1" },
          { ts: "1.2", text: "second", user: "U2" },
        ],
      })
    );

    const result = await getThreadMessages("xoxb-token", "C123", "1.0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]!.text).toBe("first");
    }
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/conversations.replies?channel=C123&ts=1.0&limit=200");
  });

  it("passes oldest to fetch only newer replies", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [] }));

    await getThreadMessages("xoxb-token", "C123", "1.0", "1.5");

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://slack.com/api/conversations.replies?channel=C123&ts=1.0&limit=200&oldest=1.5"
    );
  });

  it("follows next_cursor pagination and concatenates pages", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ ts: "1.1", text: "first", user: "U1" }],
          response_metadata: { next_cursor: "cursor-2" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, messages: [{ ts: "1.2", text: "second", user: "U2" }] })
      );

    const result = await getThreadMessages("xoxb-token", "C123", "1.0", "1.0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.map((m) => m.text)).toEqual(["first", "second"]);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [secondUrl] = fetchSpy.mock.calls[1]!;
    expect(String(secondUrl)).toContain("cursor=cursor-2");
    expect(String(secondUrl)).toContain("oldest=1.0");
  });

  it("returns Slack's error envelope on lookup failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "thread_not_found" })
    );

    const result = await getThreadMessages("xoxb-token", "C123", "1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("thread_not_found");
    }
  });

  it("returns the failure arm when a later page errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ ts: "1.1", text: "first", user: "U1" }],
          response_metadata: { next_cursor: "cursor-2" },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "ratelimited" }));

    const result = await getThreadMessages("xoxb-token", "C123", "1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ratelimited");
    }
  });
});

describe("getUserInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches user info via GET with user query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        user: { id: "U1", name: "alice", profile: { display_name: "Alice S" } },
      })
    );

    const result = await getUserInfo("xoxb-token", "U1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe("U1");
      expect(result.user.profile?.display_name).toBe("Alice S");
    }
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/users.info?user=U1");
  });

  it("returns Slack's error envelope on user_not_found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "user_not_found" })
    );

    const result = await getUserInfo("xoxb-token", "U404");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("user_not_found");
    }
  });
});

describe("publishView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts user_id and view to views.publish", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const view = { type: "home", blocks: [] };
    const result = await publishView("xoxb-token", "U1", view);

    expect(result.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/views.publish");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.user_id).toBe("U1");
    expect(body.view).toEqual(view);
  });

  it("returns Slack's error envelope on hash_conflict", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "hash_conflict" })
    );

    const result = await publishView("xoxb-token", "U1", { type: "home" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("hash_conflict");
    }
  });
});

describe("openView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts trigger_id and view to views.open", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const view = { type: "modal", title: { type: "plain_text", text: "T" } };
    await openView("xoxb-token", "trig.1", view);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/views.open");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.trigger_id).toBe("trig.1");
    expect(body.view).toEqual(view);
  });

  it("returns Slack's error envelope on expired trigger", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "expired_trigger_id" })
    );

    const result = await openView("xoxb-token", "trig.1", { type: "modal" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("expired_trigger_id");
    }
  });
});

describe("listChannels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes a single page and requests public + private, non-archived", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_private: false, is_member: true },
          { id: "C2", name: "secret", is_private: true, is_member: false },
        ],
        response_metadata: { next_cursor: "" },
      })
    );

    const result = await listChannels("xoxb-token");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channels).toEqual([
        { id: "C1", name: "general", isPrivate: false, isMember: true },
        { id: "C2", name: "secret", isPrivate: true, isMember: false },
      ]);
    }
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("conversations.list");
    expect(url).toContain("types=public_channel%2Cprivate_channel");
    expect(url).toContain("exclude_archived=true");
    expect(url).toContain("limit=1000");
  });

  it("follows next_cursor pagination and concatenates pages", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          channels: [{ id: "C1", name: "a" }],
          response_metadata: { next_cursor: "cur-2" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          channels: [{ id: "C2", name: "b" }],
          response_metadata: { next_cursor: "" },
        })
      );

    const result = await listChannels("xoxb-token");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channels.map((c) => c.id)).toEqual(["C1", "C2"]);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]![0])).toContain("cursor=cur-2");
  });

  it("returns the Slack failure envelope when a page errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "missing_scope" })
    );

    const result = await listChannels("xoxb-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing_scope");
    }
  });
});

describe("getMessageFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a single top-level message via conversations.history without oldest", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        messages: [{ ts: "1.0", files: [{ id: "F1", mimetype: "image/png" }] }],
      })
    );

    const result = await getMessageFiles("xoxb-token", "C123", "1.0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.id).toBe("F1");
    }
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://slack.com/api/conversations.history?channel=C123&latest=1.0&inclusive=true&limit=1"
    );
  });

  it("fetches a thread reply via conversations.replies anchored on oldest", async () => {
    // conversations.replies returns oldest-first, so an oldest=<ts> anchor puts
    // the target reply first in the window; a latest anchor would return the
    // thread root instead.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        messages: [{ ts: "1.5", files: [{ id: "F2", mimetype: "image/jpeg" }] }, { ts: "1.7" }],
      })
    );

    const result = await getMessageFiles("xoxb-token", "C123", "1.5", "1.0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.id).toBe("F2");
    }
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://slack.com/api/conversations.replies?channel=C123&ts=1.0&oldest=1.5&inclusive=true&limit=2"
    );
  });

  it("finds the target reply even when the thread root is included in the page", async () => {
    // Some conversations.replies responses include the thread root alongside
    // the windowed replies; find-by-ts must still pick the target.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        messages: [{ ts: "1.0" }, { ts: "1.5", files: [{ id: "F3", mimetype: "image/png" }] }],
      })
    );

    const result = await getMessageFiles("xoxb-token", "C123", "1.5", "1.0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files[0]!.id).toBe("F3");
    }
  });

  it("uses conversations.history when threadTs equals ts (thread parent)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [{ ts: "1.0" }] }));

    await getMessageFiles("xoxb-token", "C123", "1.0", "1.0");

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("conversations.history");
  });

  it("returns empty files when the message has none or is not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: true, messages: [{ ts: "9.9" }] })
    );

    expect(await getMessageFiles("xoxb-token", "C123", "1.0")).toEqual({ ok: true, files: [] });
  });

  it("returns the failure arm on Slack API errors (e.g. missing_scope)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "missing_scope" })
    );

    expect(await getMessageFiles("xoxb-token", "C123", "1.0")).toEqual({
      ok: false,
      error: "missing_scope",
    });
  });
});
