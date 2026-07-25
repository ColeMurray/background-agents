import { describe, expect, it } from "vitest";
import { appendTranscript } from "./transcription";

describe("appendTranscript", () => {
  it("puts the transcript into an empty editable draft", () => {
    expect(appendTranscript("", "  Run the tests. ")).toBe("Run the tests.");
  });

  it("keeps existing draft text instead of submitting or replacing it", () => {
    expect(appendTranscript("First inspect the route.  ", "Then run Vitest.")).toBe(
      "First inspect the route. Then run Vitest."
    );
  });
});
