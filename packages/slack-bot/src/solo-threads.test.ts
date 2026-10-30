import { describe, expect, it, vi } from "vitest";
import type { SoloThreadRecord } from "./sessions/solo-thread-store";
import {
  decideSoloThreadReply,
  judgeThreadParticipation,
  toSoloThreadReply,
  type ThreadParticipation,
} from "./solo-threads";

const OWNER = "U123";
const ROOT_TS = "1.000";
const owned: SoloThreadRecord = { kind: "owned", ownerUserId: OWNER };

describe("judgeThreadParticipation", () => {
  const root = { ts: ROOT_TS, text: "<@UBOT> fix it", user: OWNER };
  const complete = (...messages: { ts: string; text: string; user?: string; bot_id?: string }[]) =>
    ({ ok: true, messages: [root, ...messages], truncated: false }) as const;

  it.each([
    ["only the owner", complete({ ts: "1.1", text: "more", user: OWNER })],
    ["bots and Slackbot", complete({ ts: "1.1", text: "hi", user: "UAPP", bot_id: "B1" })],
    ["Slackbot", complete({ ts: "1.1", text: "reminder", user: "USLACKBOT" })],
  ])("is solo with %s", (_label, history) => {
    expect(judgeThreadParticipation(history, ROOT_TS, OWNER)).toBe("solo");
  });

  it("is shared once another person posted, even in a truncated read", () => {
    const history = {
      ok: true,
      messages: [root, { ts: "1.1", text: "+1", user: "U999" }],
      truncated: true,
    } as const;
    expect(judgeThreadParticipation(history, ROOT_TS, OWNER)).toBe("shared");
  });

  it.each([
    ["Slack failed", { ok: false } as const],
    ["the page cap cut the read", { ok: true, messages: [root], truncated: true } as const],
    ["the root is missing", { ok: true, messages: [], truncated: false } as const],
    ["a message names neither a person nor a bot", complete({ ts: "1.1", text: "joined" })],
  ])("is unknown when %s", (_label, history) => {
    expect(judgeThreadParticipation(history, ROOT_TS, OWNER)).toBe("unknown");
  });
});

describe("toSoloThreadReply", () => {
  const reply = {
    type: "message",
    channel_type: "channel",
    user: OWNER,
    channel: "C1",
    ts: "2.000",
    thread_ts: ROOT_TS,
    text: "also this",
  };

  it.each([{}, { subtype: "file_share" }, { channel_type: "group" }, { text: "", files: [{}] }])(
    "admits %j",
    (overrides) => {
      expect(toSoloThreadReply({ ...reply, ...overrides })).toMatchObject({
        sentToChannel: false,
      });
    }
  );

  it("admits an also-send-to-channel reply, marked as sent to the channel", () => {
    expect(toSoloThreadReply({ ...reply, subtype: "thread_broadcast" })).toMatchObject({
      sentToChannel: true,
    });
  });

  it.each([
    { subtype: "message_changed" },
    { channel_type: "im" },
    { channel_type: "mpim" },
    { bot_id: "B1" },
    { user: "USLACKBOT" },
    { thread_ts: undefined },
    { ts: ROOT_TS },
    { text: "" },
  ])("rejects %j", (overrides) => {
    expect(toSoloThreadReply({ ...reply, ...overrides })).toBeNull();
  });
});

describe("decideSoloThreadReply", () => {
  function lookups(
    record: SoloThreadRecord | null,
    openSession: string | null = "session",
    participation: ThreadParticipation = "solo"
  ) {
    return {
      record: vi.fn(async () => record),
      openSession: vi.fn(async () => openSession),
      participation: vi.fn(async () => participation),
    };
  }
  const reply = { user: OWNER, text: "also this", sentToChannel: false, actionable: true };

  it("takes the owner's reply once the history confirms the thread is solo", async () => {
    await expect(decideSoloThreadReply(reply, "UBOT", lookups(owned))).resolves.toEqual({
      kind: "take",
      session: "session",
    });
  });

  it.each([
    ["an unrecorded thread", null, {}, { kind: "ignore", reason: "not_solo" }],
    ["a blocked thread", { kind: "blocked" }, {}, { kind: "ignore", reason: "blocked" }],
    ["another person's reply", owned, { user: "U999" }, { kind: "block", reason: "other_poster" }],
    [
      "another person's reply also sent to the channel",
      owned,
      { user: "U999", sentToChannel: true },
      { kind: "block", reason: "other_poster" },
    ],
    [
      "the owner's reply also sent to the channel",
      owned,
      { sentToChannel: true },
      { kind: "ignore", reason: "sent_to_channel" },
    ],
    [
      "the owner's reply with nothing to run",
      owned,
      { actionable: false },
      { kind: "ignore", reason: "nothing_to_run" },
    ],
    ["a tagged reply", owned, { text: "<@UBOT> also" }, { kind: "ignore", reason: "mentions_bot" }],
    [
      "a reply addressed to a teammate",
      owned,
      { text: "<@U555> can you check?" },
      { kind: "ignore", reason: "addressed_to_teammate" },
    ],
  ] as const)(
    "decides %s before any session or history lookup",
    async (_label, record, overrides, expected) => {
      const deps = lookups(record);
      await expect(
        decideSoloThreadReply({ ...reply, ...overrides }, "UBOT", deps)
      ).resolves.toEqual(expected);
      expect(deps.openSession).not.toHaveBeenCalled();
      expect(deps.participation).not.toHaveBeenCalled();
    }
  );

  it("ignores a reply in a thread with no open session without reading the history", async () => {
    const deps = lookups(owned, null);
    await expect(decideSoloThreadReply(reply, "UBOT", deps)).resolves.toEqual({
      kind: "ignore",
      reason: "no_open_session",
    });
    expect(deps.participation).not.toHaveBeenCalled();
  });

  it.each([
    ["shared", { kind: "block", reason: "other_poster_in_history" }],
    ["unknown", { kind: "ignore", reason: "history_incomplete" }],
  ] as const)("does not take a reply when the history is %s", async (participation, expected) => {
    await expect(
      decideSoloThreadReply(reply, "UBOT", lookups(owned, "session", participation))
    ).resolves.toEqual(expected);
  });
});
