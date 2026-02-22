import { describe, expect, it } from "vitest";
import { escapeHtml } from "./webhook-handler";

describe("escapeHtml", () => {
  it("escapes & to &amp;", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes < to &lt;", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes > to &gt;", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it('escapes " to &quot;', () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("returns safe strings unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes multiple special chars in one string", () => {
    expect(escapeHtml('<div class="x">&</div>')).toBe(
      "&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;"
    );
  });

  it("does not escape single quotes", () => {
    expect(escapeHtml("it's")).toBe("it's");
  });

  it("does not double-escape & in existing entities", () => {
    // & is escaped first, so &lt; input becomes &amp;lt;
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});
