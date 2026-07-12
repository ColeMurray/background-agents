import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  deletePendingRequest,
  getPendingRequest,
  storePendingRequest,
  type PendingRequest,
} from "./pending-request-store";

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

  it("stores requests under the thread key for one hour", async () => {
    const request: PendingRequest = {
      message: "Fix the tests",
      userId: "U123",
      previousMessages: ["Earlier context"],
      channelName: "engineering",
      channelDescription: "Build discussion",
    };

    await storePendingRequest(mocks.env, "C123", "111.222", request);

    expect(mocks.put).toHaveBeenCalledWith("pending:C123:111.222", JSON.stringify(request), {
      expirationTtl: 3600,
    });
  });

  it("reads and deletes requests using the same key", async () => {
    const request: PendingRequest = { message: "Fix it", userId: "U123" };
    mocks.get.mockResolvedValue(request);

    await expect(getPendingRequest(mocks.env, "C123", "111.222")).resolves.toEqual(request);
    expect(mocks.get).toHaveBeenCalledWith("pending:C123:111.222", "json");

    await deletePendingRequest(mocks.env, "C123", "111.222");
    expect(mocks.deleteValue).toHaveBeenCalledWith("pending:C123:111.222");
  });

  it("rejects missing and non-object values", async () => {
    mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce("invalid");

    await expect(getPendingRequest(mocks.env, "C123", "111.222")).resolves.toBeNull();
    await expect(getPendingRequest(mocks.env, "C123", "111.222")).resolves.toBeNull();
  });

  it.each([
    {},
    [],
    { message: "Fix it" },
    { userId: "U123" },
    { message: 123, userId: "U123" },
    { message: "Fix it", userId: "" },
    { message: "Fix it", userId: "U123", previousMessages: ["valid", 123] },
    { message: "Fix it", userId: "U123", channelName: 123 },
  ])("rejects malformed records: %j", async (record) => {
    mocks.get.mockResolvedValue(record);

    await expect(getPendingRequest(mocks.env, "C123", "111.222")).resolves.toBeNull();
  });

  it("accepts valid minimal and complete records", async () => {
    const minimal = { message: "Fix it", userId: "U123" };
    const complete = {
      ...minimal,
      previousMessages: ["Earlier context"],
      channelName: "engineering",
      channelDescription: "Build discussion",
    };
    mocks.get.mockResolvedValueOnce(minimal).mockResolvedValueOnce(complete);

    await expect(getPendingRequest(mocks.env, "C123", "111.222")).resolves.toEqual(minimal);
    await expect(getPendingRequest(mocks.env, "C123", "111.222")).resolves.toEqual(complete);
  });
});
