import { describe, expect, it } from "vitest";
import { splitIntoSlackSections } from "./sections";

describe("splitIntoSlackSections", () => {
  it("preserves whitespace exactly across section boundaries", () => {
    const text = `\n  alpha\n\n\n\n\nbeta\n\n${"x".repeat(4000)}  \n`;
    const sections = splitIntoSlackSections(text);

    expect(sections.join("")).toBe(text);
  });

  it("keeps Unicode code points intact across hard section boundaries", () => {
    const text = `${"a".repeat(2999)}😀${"b".repeat(10)}`;
    const sections = splitIntoSlackSections(text);

    expect(sections.join("")).toBe(text);
    for (const section of sections) {
      const firstCodeUnit = section.charCodeAt(0);
      const lastCodeUnit = section.charCodeAt(section.length - 1);
      expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    }
  });

  it("rejects a section budget that cannot fit the next Unicode code point", () => {
    expect(() => splitIntoSlackSections("😀", 1)).toThrow(
      new RangeError("Section budget is too small to fit the next Unicode code point")
    );
  });

  it("keeps Unicode code points intact when adding the truncation marker", () => {
    for (let prefixLength = 2900; prefixLength <= 3000; prefixLength += 1) {
      const text = `${"a".repeat(prefixLength)}😀${"b".repeat(4000)}\n\nmore`;
      const [section] = splitIntoSlackSections(text, 3000, 1);
      const markerIndex = section.indexOf("_...truncated");
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      const content = section.slice(0, markerIndex).trimEnd();
      const lastCodeUnit = content.charCodeAt(content.length - 1);
      expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
    }
  });

  it("balances fences that open and close on the same line", () => {
    const fence = "```";
    const sections = splitIntoSlackSections(`${fence}code${fence}\n${"after ".repeat(700)}`);

    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect((section.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("caps and preserves one oversized token that opens and closes a fence", () => {
    const fenceInfo = "x".repeat(32);
    const reopenRepair = `\`\`\`${fenceInfo}\n`;
    const closeRepair = "\n```";
    const text = `\`\`\`${"x".repeat(4000)}\`\`\``;
    const sections = splitIntoSlackSections(text);

    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.length).toBeLessThanOrEqual(3000);
      expect((section.match(/```/g) ?? []).length % 2).toBe(0);
    }

    const recovered = sections
      .map((section, index) => {
        if (index > 0) expect(section.startsWith(reopenRepair)).toBe(true);
        if (index < sections.length - 1) expect(section.endsWith(closeRepair)).toBe(true);
        const withoutReopen = index > 0 ? section.slice(reopenRepair.length) : section;
        return index < sections.length - 1
          ? withoutReopen.slice(0, -closeRepair.length)
          : withoutReopen;
      })
      .join("");
    expect(recovered).toBe(text);
  });

  it("loses no characters when hard-slicing inside a fence", () => {
    const payload = "b".repeat(7000);
    const sections = splitIntoSlackSections(`\`\`\`js\n${payload}\n\`\`\``);
    const recovered = sections
      .join("")
      .split("```")
      .join("")
      .replace(/^js$/gm, "")
      .replace(/\n/g, "");
    expect(recovered).toBe(payload);
  });

  it("keeps fences balanced in the truncated final section", () => {
    const text = `\`\`\`ts\n${Array.from({ length: 400 }, () => "y".repeat(2900)).join("\n")}\n\`\`\``;
    const sections = splitIntoSlackSections(text);
    const last = sections[sections.length - 1];
    expect(last).toContain("truncated");
    expect(last.length).toBeLessThanOrEqual(3000);
    for (const section of sections) {
      expect((section.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  // The truncation cut can land inside a fence the final section both opened and
  // closed, which a trailing-fence check cannot detect. Sweep the section length
  // through the window where slicing actually happens, moving the fence across the
  // cut point, and assert the invariant holds for every shape.
  it("keeps fences balanced when the truncation cut lands inside a fence", () => {
    const fence = "```";
    for (let sectionLen = 2949; sectionLen <= 3000; sectionLen += 1) {
      for (const codeLen of [20, 45, 200]) {
        const block = `\n${fence}ts\n${"h".repeat(codeLen)}\n${fence}`;
        const fill = sectionLen - block.length;
        if (fill < 1) continue;
        const paragraphs = [
          ...Array.from({ length: 19 }, () => "f".repeat(2900)),
          "g".repeat(fill) + block,
          ...Array.from({ length: 5 }, () => "z".repeat(2900)),
        ];
        const sections = splitIntoSlackSections(paragraphs.join("\n\n"));
        const last = sections[sections.length - 1];
        expect(last).toContain("truncated");
        expect(last.length).toBeLessThanOrEqual(3000);
        expect((last.match(/```/g) ?? []).length % 2).toBe(0);
      }
    }
  });

  it("carries the fence language across a split", () => {
    const sections = splitIntoSlackSections(`\`\`\`python\n${"c".repeat(6500)}\n\`\`\``);
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections.slice(1)) {
      expect(section.startsWith("```python\n")).toBe(true);
    }
  });
});

describe("fence info bounding", () => {
  // Regression: `info` was captured unbounded from the fence line, so an
  // oversized fence-opener was re-emitted on every continuation section and
  // overflowed Slack's per-section cap.
  it("keeps sections within the cap for an oversized fence-opener line", () => {
    const monsterInfo = "x".repeat(4000);
    const sections = splitIntoSlackSections(`\`\`\`${monsterInfo}\n${"c".repeat(5000)}\n\`\`\``);
    for (const section of sections) {
      expect(section.length).toBeLessThanOrEqual(3000);
    }
  });

  it("keeps only the language token when the fence line carries trailing text", () => {
    const sections = splitIntoSlackSections(
      `\`\`\`python title="a very long annotation ${"y".repeat(200)}"\n${"c".repeat(6500)}\n\`\`\``
    );
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections.slice(1)) {
      expect(section.startsWith("```python\n")).toBe(true);
    }
  });

  it("never overflows across a sweep of fence-opener and body lengths", () => {
    for (let infoLen = 0; infoLen <= 4200; infoLen += 350) {
      for (let bodyLen = 2900; bodyLen <= 6200; bodyLen += 550) {
        const text = `\`\`\`${"i".repeat(infoLen)}\n${"b".repeat(bodyLen)}\n\`\`\``;
        for (const section of splitIntoSlackSections(text)) {
          expect(section.length).toBeLessThanOrEqual(3000);
          expect((section.match(/```/g) ?? []).length % 2).toBe(0);
        }
      }
    }
  });
});
