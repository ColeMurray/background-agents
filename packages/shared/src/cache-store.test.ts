import { describe, expect, it } from "vitest";
import { prefixKeyValueStore, type KeyValueStore } from "./cache-store";

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  function get(key: string): Promise<string | null>;
  function get(key: string, type: "json"): Promise<unknown | null>;
  function get(key: string, type?: "json"): Promise<string | unknown | null> {
    const value = values.get(key) ?? null;
    return Promise.resolve(type === "json" && value !== null ? JSON.parse(value) : value);
  }
  return {
    get,
    put(key, value) {
      values.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      values.delete(key);
      return Promise.resolve();
    },
    list({ prefix }) {
      return Promise.resolve({
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      });
    },
  };
}

describe("prefixKeyValueStore", () => {
  it("isolates logical stores and hides the physical prefix", async () => {
    const physical = memoryStore();
    const slack = prefixKeyValueStore(physical, "slack");
    const linear = prefixKeyValueStore(physical, "linear");

    await slack.put("session:1", "slack");
    await linear.put("session:1", "linear");

    await expect(slack.get("session:1")).resolves.toBe("slack");
    await expect(linear.get("session:1")).resolves.toBe("linear");
    await expect(slack.list({ prefix: "session:" })).resolves.toEqual({
      keys: [{ name: "session:1" }],
    });
  });
});
