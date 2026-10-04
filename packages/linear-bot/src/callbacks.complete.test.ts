import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbacksRouter } from "./callbacks";
import { createFakeKV, makeExecutionContext, makeLinearBotEnv } from "./test-helpers";

const SECRET = "callback-secret";
const SIZE_LIMIT_ERROR =
  "The agent's response exceeded the event size limit and was not delivered in full.";

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function postFailedCompletion(options: {
  text?: string;
  eventError?: string;
  callbackError?: string;
}): Promise<string> {
  const { kv } = createFakeKV();
  const controlPlaneFetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes("/events")
      ? Response.json({
          events: [
            ...(options.text
              ? [
                  {
                    id: "token-1",
                    type: "token",
                    data: { content: options.text },
                    messageId: "message-1",
                    createdAt: 1,
                  },
                ]
              : []),
            {
              id: "complete-1",
              type: "execution_complete",
              data: {
                success: false,
                ...(options.eventError ? { error: options.eventError } : {}),
              },
              messageId: "message-1",
              createdAt: 2,
            },
          ],
          hasMore: false,
        })
      : Response.json({ artifacts: [] })
  );
  const linearFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) =>
      String(init?.body).includes("IssueTeam")
        ? Response.json({ data: { issue: { id: "issue-1", team: { id: "external-team-1" } } } })
        : Response.json({ data: { commentCreate: { success: true } } })
    );
  const env = makeLinearBotEnv(kv, {
    SERVICE_AUTH_SECRET: SECRET,
    LINEAR_API_KEY: "linear-key",
    CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
  });
  const data = {
    sessionId: "session-1",
    messageId: "message-1",
    success: false,
    ...(options.callbackError ? { error: options.callbackError } : {}),
    timestamp: Date.now(),
    context: {
      source: "linear",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      linearTeamId: "external-team-1",
      model: "anthropic/claude-haiku-4-5",
    },
  };
  const payload = { ...data, signature: await computeHmacHex(JSON.stringify(data), SECRET) };
  const ctx = makeExecutionContext();
  const response = await callbacksRouter.fetch(
    new Request("http://localhost/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    env,
    ctx
  );

  expect(response.status).toBe(200);
  await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));
  expect(linearFetch).toHaveBeenCalledTimes(2);
  const body = JSON.parse(String(linearFetch.mock.calls[1][1]?.body));
  return body.variables.input.body;
}

describe("POST /complete failure", () => {
  it("shows the execution error before incomplete text", async () => {
    const body = await postFailedCompletion({
      text: "Partial answer",
      eventError: SIZE_LIMIT_ERROR,
      callbackError: "Fallback error",
    });

    expect(body).toContain(`The agent encountered an error: ${SIZE_LIMIT_ERROR}\n\nPartial answer`);
    expect(body).not.toContain("Fallback error");
  });

  it("shows the callback error when no token or event error was recorded", async () => {
    const body = await postFailedCompletion({ callbackError: SIZE_LIMIT_ERROR });

    expect(body).toContain(`The agent encountered an error: ${SIZE_LIMIT_ERROR}`);
  });

  it.each(["eventError", "callbackError"] as const)(
    "omits an oversized, sensitive %s while keeping partial text",
    async (source) => {
      const body = await postFailedCompletion({
        text: "Partial answer",
        [source]: `Provider error at https://user:secret-token@example.test/ ${"x".repeat(1_000_000)}`,
      });

      expect(body).toContain(
        "The agent encountered an error: Error details omitted for safety.\n\nPartial answer"
      );
      expect(body).not.toContain("secret-token");
      expect(body.length).toBeLessThan(1_000);
    }
  );

  it("keeps incomplete text when no error reason exists", async () => {
    const body = await postFailedCompletion({ text: "Partial answer" });

    expect(body).toContain("The agent encountered an error.\n\nPartial answer");
  });

  it("keeps the generic failure text when no error reason exists", async () => {
    const body = await postFailedCompletion({});

    expect(body).toContain("The agent was unable to complete this task.");
  });
});
