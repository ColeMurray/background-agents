import { describe, it, expect } from "vitest";
import { normalizeRepoId, getRepoMetadataKey } from "./repo";

describe("repo utilities", () => {
  describe("normalizeRepoId", () => {
    it("converts owner and name to lowercase", () => {
      expect(normalizeRepoId("MyOrg", "MyRepo")).toBe("myorg/myrepo");
    });

    it("formats as owner/name", () => {
      expect(normalizeRepoId("owner", "repo")).toBe("owner/repo");
    });
  });

  describe("getRepoMetadataKey", () => {
    it("returns correct KV key format", () => {
      expect(getRepoMetadataKey("owner", "repo")).toBe("repo:metadata:owner/repo");
    });

    it("normalizes owner and name in the key", () => {
      expect(getRepoMetadataKey("MyOrg", "MyRepo")).toBe("repo:metadata:myorg/myrepo");
    });

    it("produces consistent keys for different case variations", () => {
      const key1 = getRepoMetadataKey("GitHub", "OpenInspect");
      const key2 = getRepoMetadataKey("github", "openinspect");
      const key3 = getRepoMetadataKey("GITHUB", "OPENINSPECT");

      expect(key1).toBe(key2);
      expect(key2).toBe(key3);
    });
  });
});
