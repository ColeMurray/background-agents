import { describe, expect, it } from "vitest";
import { collectForwardedMessages } from "./forwarded-messages";

/**
 * The fixture mirrors a real forwarded-message attachment: Slack fills
 * `is_msg_unfurl`/`is_share`, puts the shared message's body in `text`, and
 * carries its source ids and files, while the forwarding message's own `text`
 * holds only the user's comment.
 */
function shareAttachment(overrides: Record<string, unknown> = {}) {
  return {
    is_msg_unfurl: true,
    is_share: true,
    author_name: "Ada Lovelace",
    channel_name: "engineering",
    channel_id: "C0AGWUDM1LZ",
    ts: "1783009861.339949",
    from_url:
      "https://acme.slack.com/archives/C0AGWUDM1LZ/p1783009861339949?thread_ts=1783009861.339949&cid=C0AGWUDM1LZ",
    text: "The analytics job has been failing since Tuesday",
    fallback: "[February 9th, 2026 12:30 PM] ada: The analytics job has been failing since Tuesday",
    ...overrides,
  };
}

const sourceLine =
  "Source: https://acme.slack.com/archives/C0AGWUDM1LZ/p1783009861339949?thread_ts=1783009861.339949&cid=C0AGWUDM1LZ — Slack channel C0AGWUDM1LZ — message ts 1783009861.339949";

describe("collectForwardedMessages", () => {
  it("returns nothing when the message carried no attachments", () => {
    expect(collectForwardedMessages(undefined)).toEqual({
      entries: [],
      files: [],
      hasBody: false,
    });
    expect(collectForwardedMessages([])).toEqual({ entries: [], files: [], hasBody: false });
  });

  it("quotes the body under its author, channel, and a fetchable source", () => {
    // The source line is what lets an agent with Slack tooling pull the full
    // original thread: permalink, channel id, and message ts.
    expect(collectForwardedMessages([shareAttachment()]).entries).toEqual([
      [
        "[Forwarded message from Ada Lovelace in #engineering]",
        sourceLine,
        "The analytics job has been failing since Tuesday",
      ].join("\n"),
    ]);
  });

  it("keeps links in the body exactly as Slack sent them", () => {
    const [entry] = collectForwardedMessages([
      shareAttachment({
        text: "see <https://linear.app/acme/issue/FE-532|FE-532> and <https://acme.test/runbook>",
      }),
    ]).entries;
    expect(entry).toContain(
      "see <https://linear.app/acme/issue/FE-532|FE-532> and <https://acme.test/runbook>"
    );
  });

  it("omits attribution Slack did not provide", () => {
    // Slack leaves channel_name off when the bot cannot see the source channel.
    expect(
      collectForwardedMessages([
        shareAttachment({ channel_name: undefined, author_name: undefined }),
      ]).entries[0]
    ).toBe(
      ["[Forwarded message]", sourceLine, "The analytics job has been failing since Tuesday"].join(
        "\n"
      )
    );
  });

  it("returns the shared message's files for the image path", () => {
    const files = [
      {
        id: "F1",
        name: "image.png",
        mimetype: "image/png",
        url_private: "https://files.slack.com/files-pri/T1-F1/image.png",
        size: 385424,
      },
    ];
    expect(collectForwardedMessages([shareAttachment({ files })]).files).toEqual(files);
  });

  it("keeps an image-only shared message, marking that it had no text", () => {
    const files = [{ id: "F1", mimetype: "image/png", url_private: "https://x.slack.com/f" }];
    const result = collectForwardedMessages([
      shareAttachment({ text: "", fallback: undefined, files }),
    ]);
    expect(result.entries[0]).toContain("(no text)");
    expect(result.files).toEqual(files);
    expect(result.hasBody).toBe(false);
  });

  it("falls back to Slack's plain-text rendering when the share has no text", () => {
    // Shared app posts keep their content in their own attachments/blocks, so
    // `text` can be empty while `fallback` still renders the message.
    const result = collectForwardedMessages([shareAttachment({ text: "" })]);
    expect(result.entries[0]).toContain(
      "[February 9th, 2026 12:30 PM] ada: The analytics job has been failing since Tuesday"
    );
    expect(result.hasBody).toBe(true);
  });

  it("skips link unfurls, which only restate a link the text already carries", () => {
    expect(
      collectForwardedMessages([
        {
          is_msg_unfurl: true,
          text: "The referenced Slack message",
          fallback: "[February 9th, 2026 12:30 PM] ada: The referenced Slack message",
          from_url: "https://acme.slack.com/archives/C123/p1770652200000000",
        },
      ])
    ).toEqual({ entries: [], files: [], hasBody: false });
  });

  it("treats a whitespace-only body as absent so the fallback still shows", () => {
    expect(collectForwardedMessages([shareAttachment({ text: "   " })]).entries[0]).toContain(
      "[February 9th, 2026 12:30 PM] ada: The analytics job has been failing since Tuesday"
    );
  });

  it("skips shares with neither a body nor files", () => {
    expect(
      collectForwardedMessages([shareAttachment({ text: "   ", fallback: undefined })])
    ).toEqual({ entries: [], files: [], hasBody: false });
  });

  it("keeps every shared message when several are forwarded at once", () => {
    const result = collectForwardedMessages([
      shareAttachment({ text: "first" }),
      shareAttachment({ text: "second", author_name: "Grace Hopper" }),
    ]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toContain("from Ada Lovelace");
    expect(result.entries[0]).toContain("first");
    expect(result.entries[1]).toContain("from Grace Hopper");
    expect(result.entries[1]).toContain("second");
    expect(result.hasBody).toBe(true);
  });

  it("caps the number of shared messages folded into the prompt", () => {
    const many = Array.from({ length: 25 }, (_, i) => shareAttachment({ text: `body ${i}` }));
    const result = collectForwardedMessages(many);
    expect(result.entries).toHaveLength(10);
    expect(result.entries[9]).toContain("body 9");
  });

  it("truncates a single oversized body instead of dropping it", () => {
    const [entry] = collectForwardedMessages([shareAttachment({ text: "x".repeat(5000) })]).entries;
    const body = entry!.split("\n").at(-1)!;
    // The marker counts against the cap rather than pushing the body past it.
    expect(body.endsWith("… [truncated]")).toBe(true);
    expect(body).toHaveLength(4000);
  });
});
