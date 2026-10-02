import { describe, it, expect } from "vitest";
import { boundedSessionReference, referenceMarker, sessionReferences } from "./session-references";
describe("explicit session references", () => {
  it("round trips markers without accepting malformed IDs or injected labels", () => {
    expect(sessionReferences(referenceMarker("abc-123", "Report]\nDone"))).toEqual([
      { id: "abc-123", label: "Report  Done", marker: "#[Report  Done](session:abc-123)" },
    ]);
    expect(sessionReferences("#nothing #[Bad](session:../secret)")).toEqual([]);
  });
  it("projects only summary fields and caps escaped Unicode payloads", () => {
    const raw = {
      id: "a",
      title: "Title",
      target: "acme/repo",
      status: "completed",
      project: null,
      pullRequests: Array.from({ length: 50 }, () => ({
        url: "https://example.org/" + "x".repeat(2048),
        state: "open",
      })),
      finalAssistantExcerpt: "\n😀".repeat(40000),
      transcript: "SECRET TRANSCRIPT",
      userPrompt: "SECRET PROMPT",
    };
    const summary = boundedSessionReference(raw);
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(4000);
    expect(summary.finalAssistantExcerpt.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });
});
