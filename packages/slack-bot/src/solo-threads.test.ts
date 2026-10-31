import { describe, expect, it } from "vitest";
import type { SoloThreadRecord } from "./sessions/solo-thread-store";
import { judgeThreadParticipation, screenSoloReply, toSoloThreadReply } from "./solo-threads";

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

describe("screenSoloReply", () => {
  const reply = { user: OWNER, text: "also this", sentToChannel: false };

  it.each([
    ["the owner's reply", owned, {}, "verify"],
    ["an unrecorded thread", null, {}, "ignore"],
    ["a blocked thread", { kind: "blocked" }, {}, "ignore"],
    ["another person's reply", owned, { user: "U999" }, "block"],
    [
      "another person's reply also sent to the channel",
      owned,
      { user: "U999", sentToChannel: true },
      "block",
    ],
    ["the owner's reply also sent to the channel", owned, { sentToChannel: true }, "ignore"],
    ["a tagged reply", owned, { text: "<@UBOT> also" }, "ignore"],
    ["a reply addressed to a teammate", owned, { text: "<@U555> can you check?" }, "ignore"],
  ] as const)("screens %s as %s", (_label, record, overrides, expected) => {
    expect(screenSoloReply(record, { ...reply, ...overrides }, "UBOT")).toBe(expected);
  });
});
