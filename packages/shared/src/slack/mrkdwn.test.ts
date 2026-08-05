import { describe, expect, it } from "vitest";

import {
  applyMentionPolicy,
  escapeMrkdwnText,
  sanitizeAgentText,
  sanitizeLinks,
  stripBroadcastMentions,
  truncateForSlack,
} from "./mrkdwn";

describe("escapeMrkdwnText", () => {
  it("neutralizes broadcast mentions", () => {
    expect(escapeMrkdwnText("<!channel> deploy")).toBe("&lt;!channel&gt; deploy");
  });

  it("neutralizes user mentions and links", () => {
    expect(escapeMrkdwnText("<@U123> see <https://x.test|here>")).toBe(
      "&lt;@U123&gt; see &lt;https://x.test|here&gt;"
    );
  });

  it("escapes ampersands first so entities are not double-escaped", () => {
    expect(escapeMrkdwnText("a & b &lt;")).toBe("a &amp; b &amp;lt;");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeMrkdwnText("full-stack env")).toBe("full-stack env");
  });
});

describe("stripBroadcastMentions", () => {
  it("removes <!channel>", () => {
    expect(stripBroadcastMentions("<!channel> hi")).toBe(" hi");
  });

  it("removes <!here>", () => {
    expect(stripBroadcastMentions("<!here>")).toBe("");
  });

  it("removes <!subteam^S123|@team>", () => {
    expect(stripBroadcastMentions("<!subteam^S123|@team>")).toBe("");
  });

  it("removes <!subteam^S123> with no display text", () => {
    expect(stripBroadcastMentions("<!subteam^S123>")).toBe("");
  });

  it("removes multiple broadcasts in one input", () => {
    expect(stripBroadcastMentions("<!channel> hi <!here> <!subteam^S123|@team>")).toBe(" hi  ");
  });

  it("preserves user mentions", () => {
    expect(stripBroadcastMentions("<!channel> hi <@U123>")).toBe(" hi <@U123>");
  });

  it("preserves channel refs", () => {
    expect(stripBroadcastMentions("<!here> see <#C123|ops>")).toBe(" see <#C123|ops>");
  });
});

describe("sanitizeLinks", () => {
  it("strips display text from mrkdwn link", () => {
    expect(sanitizeLinks("<https://evil.example|github.com>")).toBe("https://evil.example");
  });

  it("preserves bare URLs", () => {
    expect(sanitizeLinks("see https://example.com for more")).toBe(
      "see https://example.com for more"
    );
  });

  it("strips angle brackets from bare-URL-in-brackets", () => {
    expect(sanitizeLinks("<https://example.com>")).toBe("https://example.com");
  });

  it("handles empty display text", () => {
    expect(sanitizeLinks("<https://x.example|>")).toBe("https://x.example");
  });

  it("handles multiple links in one message", () => {
    expect(sanitizeLinks("a <https://a.example|A> b <https://b.example|B>")).toBe(
      "a https://a.example b https://b.example"
    );
  });

  it("preserves user mentions", () => {
    expect(sanitizeLinks("<@U123> hello")).toBe("<@U123> hello");
  });

  it("preserves channel refs", () => {
    expect(sanitizeLinks("see <#C123|ops>")).toBe("see <#C123|ops>");
  });

  it("preserves broadcast mentions", () => {
    expect(sanitizeLinks("<!channel>")).toBe("<!channel>");
  });

  it("handles mailto links", () => {
    expect(sanitizeLinks("<mailto:user@example.com|email me>")).toBe("mailto:user@example.com");
  });

  it("handles http (non-https)", () => {
    expect(sanitizeLinks("<http://internal.example|click>")).toBe("http://internal.example");
  });
});

describe("applyMentionPolicy", () => {
  it("allow keeps user mentions", () => {
    expect(applyMentionPolicy("hi <@U123>", "allow")).toBe("hi <@U123>");
  });

  it("escape converts to literal @USERID", () => {
    expect(applyMentionPolicy("hi <@U123>", "escape")).toBe("hi @U123");
  });

  it("strip removes user mentions", () => {
    expect(applyMentionPolicy("hi <@U123>", "strip")).toBe("hi ");
  });

  it("does not touch broadcast mentions under any policy", () => {
    const text = "<!channel> <@U123>";
    expect(applyMentionPolicy(text, "strip")).toBe("<!channel> ");
    expect(applyMentionPolicy(text, "escape")).toBe("<!channel> @U123");
    expect(applyMentionPolicy(text, "allow")).toBe(text);
  });

  it("handles multiple mentions", () => {
    expect(applyMentionPolicy("<@U1> hi <@U2>", "escape")).toBe("@U1 hi @U2");
  });

  it("ignores lowercase user IDs (Slack IDs are uppercase)", () => {
    expect(applyMentionPolicy("<@u123>", "strip")).toBe("<@u123>");
  });

  it("preserves channel refs", () => {
    expect(applyMentionPolicy("<#C123|ops> <@U1>", "strip")).toBe("<#C123|ops> ");
  });

  it("escape converts the piped <@ID|label> form to literal @ID", () => {
    expect(applyMentionPolicy("hi <@U123|cole>", "escape")).toBe("hi @U123");
  });

  it("strip removes the piped <@ID|label> form", () => {
    expect(applyMentionPolicy("hi <@U123|cole>", "strip")).toBe("hi ");
  });

  it("handles a mix of bare and piped mentions", () => {
    expect(applyMentionPolicy("<@U1> and <@U2|two>", "escape")).toBe("@U1 and @U2");
  });
});

describe("truncateForSlack", () => {
  it("under cap is unchanged", () => {
    expect(truncateForSlack("short", 100)).toEqual({
      text: "short",
      truncated: false,
    });
  });

  it("at exactly cap is unchanged", () => {
    expect(truncateForSlack("0123456789", 10)).toEqual({
      text: "0123456789",
      truncated: false,
    });
  });

  it("over cap is truncated with marker", () => {
    const result = truncateForSlack("0123456789".repeat(10), 30);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("… (truncated)")).toBe(true);
  });

  it("output never exceeds maxLength", () => {
    const long = "x".repeat(1000);
    const result = truncateForSlack(long, 50);
    expect(result.text.length).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
  });

  it("preserves leading content up to budget", () => {
    const result = truncateForSlack("hello world!".repeat(20), 30);
    expect(result.text.startsWith("hello world")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(30);
  });
});

describe("sanitizeAgentText", () => {
  it("composes all four sanitizers in order", () => {
    const input = "<!channel> see <https://evil.example|github.com> from <@U123>";
    const result = sanitizeAgentText(input, {
      mentionsPolicy: "allow",
      maxLength: 200,
    });
    expect(result.text).toBe(" see https://evil.example from <@U123>");
    expect(result.strippedBroadcasts).toBe(true);
    expect(result.mentionsModified).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("returns metadata flags", () => {
    const result = sanitizeAgentText("<@U1> <!channel>", {
      mentionsPolicy: "strip",
      maxLength: 100,
    });
    expect(result.strippedBroadcasts).toBe(true);
    expect(result.mentionsModified).toBe(true);
  });

  it("links sanitized before truncation (long display text does not blow the cap)", () => {
    const input = `before <https://x.example|${"a".repeat(200)}> after`;
    const result = sanitizeAgentText(input, {
      mentionsPolicy: "allow",
      maxLength: 100,
    });
    expect(result.text).toBe("before https://x.example after");
    expect(result.truncated).toBe(false);
  });

  it("clean input produces no metadata flags", () => {
    const result = sanitizeAgentText("hello world", {
      mentionsPolicy: "allow",
      maxLength: 100,
    });
    expect(result.text).toBe("hello world");
    expect(result.strippedBroadcasts).toBe(false);
    expect(result.mentionsModified).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("escape policy with user mention sets mentionsModified", () => {
    const result = sanitizeAgentText("hi <@U123>", {
      mentionsPolicy: "escape",
      maxLength: 100,
    });
    expect(result.text).toBe("hi @U123");
    expect(result.mentionsModified).toBe(true);
  });

  it("truncates after sanitization", () => {
    const input = "x".repeat(500);
    const result = sanitizeAgentText(input, {
      mentionsPolicy: "allow",
      maxLength: 50,
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(50);
  });
});
