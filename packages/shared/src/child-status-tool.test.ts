import { describe, expect, it } from "vitest";
import { childStatusToolEnvelopeSchema } from "./child-status-tool";

// The OpenCode formatter has no npm dependencies and also runs in Python CI.
// Exercise its actual output here, where Zod is installed, without requiring
// built shared artifacts in the standalone runtime tests.
const formatterUrl = new URL(
  "../../sandbox-runtime/src/sandbox_runtime/tools/get-child-status-format.js",
  import.meta.url
).href;

describe("child status tool contract", () => {
  it("accepts the OpenCode producer's list, empty list, and response payloads", async () => {
    const { childStatusListOutput, childStatusDetailOutput } = await import(formatterUrl);
    const session = { id: "child-1", title: "Test child", status: "completed" };
    const outputs = [
      childStatusListOutput([session], "1 child session"),
      childStatusListOutput([], "No child sessions found."),
      childStatusDetailOutput(
        { session, finalResponse: { success: true, textContent: "## Done" } },
        session.id
      ),
      childStatusDetailOutput({ session }, session.id),
    ];
    expect(outputs).toHaveLength(4);
    for (const output of outputs) {
      expect(childStatusToolEnvelopeSchema.safeParse(JSON.parse(output)).success).toBe(true);
    }
  });

  it("rejects unknown versions and malformed nested response fields", () => {
    const payload = {
      version: 1,
      kind: "detail",
      session: { id: "child-1", status: "active" },
      agentMessage: "Child child-1",
    };
    expect(childStatusToolEnvelopeSchema.safeParse(payload).success).toBe(true);
    expect(childStatusToolEnvelopeSchema.safeParse({ ...payload, version: 2 }).success).toBe(false);
    expect(
      childStatusToolEnvelopeSchema.safeParse({
        ...payload,
        finalResponse: { success: "yes", textContent: [] },
      }).success
    ).toBe(false);
  });
});
