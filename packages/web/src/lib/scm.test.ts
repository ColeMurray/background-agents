import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getScmRepoUrl, getScmBranchUrl } from "./scm";

describe("scm", () => {
  const originalEnv = process.env.NEXT_PUBLIC_SCM_PROVIDER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_SCM_PROVIDER;
    } else {
      process.env.NEXT_PUBLIC_SCM_PROVIDER = originalEnv;
    }
    vi.resetModules();
  });

  function setProvider(value: string | undefined) {
    if (value === undefined) {
      delete process.env.NEXT_PUBLIC_SCM_PROVIDER;
    } else {
      process.env.NEXT_PUBLIC_SCM_PROVIDER = value;
    }
  }

  describe("getScmRepoUrl", () => {
    it("defaults to github when env is unset", () => {
      setProvider(undefined);
      expect(getScmRepoUrl("acme", "app")).toBe("https://github.com/acme/app");
    });

    it("returns github URL", () => {
      setProvider("github");
      expect(getScmRepoUrl("acme", "app")).toBe("https://github.com/acme/app");
    });

    it("returns gitlab URL", () => {
      setProvider("gitlab");
      expect(getScmRepoUrl("acme", "app")).toBe("https://gitlab.com/acme/app");
    });

    it("returns bitbucket URL", () => {
      setProvider("bitbucket");
      expect(getScmRepoUrl("acme", "app")).toBe("https://bitbucket.org/acme/app");
    });

    it("falls back to github for unknown provider", () => {
      setProvider("unknown");
      expect(getScmRepoUrl("acme", "app")).toBe("https://github.com/acme/app");
    });

    it("encodes owner and name", () => {
      setProvider("github");
      expect(getScmRepoUrl("my org", "my repo")).toBe(
        "https://github.com/my%20org/my%20repo"
      );
    });
  });

  describe("getScmBranchUrl", () => {
    it("returns github branch URL by default", () => {
      setProvider(undefined);
      expect(getScmBranchUrl("acme", "app", "main")).toBe(
        "https://github.com/acme/app/tree/main"
      );
    });

    it("returns gitlab branch URL with /-/tree/ path", () => {
      setProvider("gitlab");
      expect(getScmBranchUrl("acme", "app", "main")).toBe(
        "https://gitlab.com/acme/app/-/tree/main"
      );
    });

    it("returns bitbucket branch URL with /src/ path", () => {
      setProvider("bitbucket");
      expect(getScmBranchUrl("acme", "app", "main")).toBe(
        "https://bitbucket.org/acme/app/src/main"
      );
    });

    it("encodes branch names with special characters", () => {
      setProvider("github");
      expect(getScmBranchUrl("acme", "app", "feat/my branch")).toBe(
        "https://github.com/acme/app/tree/feat%2Fmy%20branch"
      );
    });

    it("encodes owner and name", () => {
      setProvider("gitlab");
      expect(getScmBranchUrl("my org", "my repo", "main")).toBe(
        "https://gitlab.com/my%20org/my%20repo/-/tree/main"
      );
    });
  });
});
