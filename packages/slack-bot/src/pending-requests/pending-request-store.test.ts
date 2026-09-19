import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  deleteLegacyPendingRequest,
  deletePendingRequest,
  getLegacyPendingRequest,
  getPendingRequest,
  storePendingRequest,
  type PendingRequest,
} from "./pending-request-store";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const TURN_PLAN = {
  sessionDefaults: {
    model: "anthropic/claude-sonnet-4-6" as const,
    reasoningEffort: "high" as const,
  },
  promptOverrides: {
    model: "openai/gpt-5.6-sol" as const,
    reasoningEffort: "high" as const,
  },
  effective: {
    model: "openai/gpt-5.6-sol" as const,
    reasoningEffort: "high" as const,
  },
};

function request(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    requestId: REQUEST_ID,
    channel: "C123",
    threadTs: "111.222",
    message: "Fix the tests",
    userId: "U123",
    ...overrides,
  };
}

function makeEnv() {
  const get = vi.fn();
  const put = vi.fn();
  const deleteValue = vi.fn();
  const env = {
    SLACK_KV: { get, put, delete: deleteValue } as unknown as KVNamespace,
  } as Env;
  return { env, get, put, deleteValue };
}

describe("pending request store", () => {
  let mocks: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    mocks = makeEnv();
  });

  it("stores requests under the request id for one hour", async () => {
    const pending = request({
      unattributedPrompt: { forwardedMessages: ["Forwarded body"] },
      previousMessages: ["Earlier context"],
      channelName: "engineering",
      channelDescription: "Build discussion",
      messageTs: "222.000003",
      threadContextSource: { threadTs: "111.222", beforeTs: "222.000003" },
      turnPlan: TURN_PLAN,
    });

    await storePendingRequest(mocks.env, pending);

    expect(mocks.put).toHaveBeenCalledWith(`pending:${REQUEST_ID}`, expect.any(String), {
      expirationTtl: 3600,
    });
    expect(JSON.parse(mocks.put.mock.calls[0][1])).toEqual(pending);
  });

  it("keeps requests in the same thread distinct", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";

    await storePendingRequest(mocks.env, request());
    await storePendingRequest(mocks.env, request({ requestId: secondId, userId: "U999" }));

    expect(mocks.put).toHaveBeenNthCalledWith(
      1,
      `pending:${REQUEST_ID}`,
      expect.any(String),
      expect.any(Object)
    );
    expect(mocks.put).toHaveBeenNthCalledWith(
      2,
      `pending:${secondId}`,
      expect.any(String),
      expect.any(Object)
    );
  });

  it("reads and deletes requests using the same request id", async () => {
    const pending = request();
    mocks.get.mockResolvedValue(pending);

    await expect(getPendingRequest(mocks.env, REQUEST_ID)).resolves.toEqual(pending);
    expect(mocks.get).toHaveBeenCalledWith(`pending:${REQUEST_ID}`, "json");

    await deletePendingRequest(mocks.env, REQUEST_ID);
    expect(mocks.deleteValue).toHaveBeenCalledWith(`pending:${REQUEST_ID}`);
  });

  it("rejects missing, malformed, and mismatched records", async () => {
    mocks.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("invalid")
      .mockResolvedValueOnce(request({ requestId: "00000000-0000-4000-8000-000000000002" }));

    await expect(getPendingRequest(mocks.env, REQUEST_ID)).resolves.toBeNull();
    await expect(getPendingRequest(mocks.env, REQUEST_ID)).resolves.toBeNull();
    await expect(getPendingRequest(mocks.env, REQUEST_ID)).resolves.toBeNull();
  });

  it.each([
    {},
    [],
    { message: "Fix it" },
    { userId: "U123" },
    { message: 123, userId: "U123" },
    { message: "Fix it", userId: "" },
    { message: "Fix it", userId: "U123", previousMessages: ["valid", 123] },
    { message: "Fix it", userId: "U123", unattributedPrompt: {} },
    { message: "Fix it", userId: "U123", unattributedPrompt: { forwardedMessages: [123] } },
    { message: "Fix it", userId: "U123", channelName: 123 },
    { message: "Fix it", userId: "U123", turnPlan: {} },
    {
      message: "Fix it",
      userId: "U123",
      turnPlan: {
        ...TURN_PLAN,
        effective: { model: "openai/gpt-5.4", reasoningEffort: "high" },
      },
    },
    { ...request(), requestId: "not-a-uuid" },
    { ...request(), channel: "" },
    { ...request(), threadTs: "" },
  ])("rejects malformed records: %j", async (record) => {
    mocks.get.mockResolvedValue(record);

    await expect(getPendingRequest(mocks.env, REQUEST_ID)).resolves.toBeNull();
  });

  it("reads and deletes legacy thread-keyed records separately", async () => {
    const legacy = {
      message: "Fix it",
      userId: "U123",
      messageTs: "222.000003",
      threadContextSource: { threadTs: "111.222", beforeTs: "222.000003" },
      inlinePromptOptions: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
    };
    mocks.get.mockResolvedValue(legacy);

    await expect(getLegacyPendingRequest(mocks.env, "C123", "111.222")).resolves.toEqual(legacy);
    expect(mocks.get).toHaveBeenCalledWith("pending:C123:111.222", "json");

    await deleteLegacyPendingRequest(mocks.env, "C123", "111.222");
    expect(mocks.deleteValue).toHaveBeenCalledWith("pending:C123:111.222");
  });
});
