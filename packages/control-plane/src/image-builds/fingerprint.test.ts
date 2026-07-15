import { describe, expect, it } from "vitest";
import { computeRepositoriesFingerprint } from "./fingerprint";
import { MIN_COMPATIBLE_RUNTIME_VERSION, parseRuntimeVersionNumber } from "./model";

const repositories = [
  { repoOwner: "Acme", repoName: "Web", baseBranch: "main" },
  { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
];

describe("computeRepositoriesFingerprint", () => {
  it("is deterministic", async () => {
    const first = await computeRepositoriesFingerprint(repositories);
    const second = await computeRepositoriesFingerprint(repositories);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is case-insensitive on owner/name", async () => {
    const upper = await computeRepositoriesFingerprint(repositories);
    const lower = await computeRepositoriesFingerprint(
      repositories.map((m) => ({
        ...m,
        repoOwner: m.repoOwner.toLowerCase(),
        repoName: m.repoName.toLowerCase(),
      }))
    );
    expect(upper).toBe(lower);
  });

  it("is case-sensitive on branch names (git refs are)", async () => {
    const main = await computeRepositoriesFingerprint(repositories);
    const casedBranch = await computeRepositoriesFingerprint([
      { ...repositories[0], baseBranch: "Main" },
      repositories[1],
    ]);
    expect(main).not.toBe(casedBranch);
  });

  it("is order-sensitive (repositories are position-ordered)", async () => {
    const forward = await computeRepositoriesFingerprint(repositories);
    const reversed = await computeRepositoriesFingerprint([...repositories].reverse());
    expect(forward).not.toBe(reversed);
  });

  it("changes when the repository set changes", async () => {
    const two = await computeRepositoriesFingerprint(repositories);
    const one = await computeRepositoriesFingerprint(repositories.slice(0, 1));
    expect(two).not.toBe(one);
  });
});

describe("parseRuntimeVersionNumber", () => {
  it("parses the numeric prefix of a SANDBOX_VERSION", () => {
    expect(parseRuntimeVersionNumber("v53-list-native-runtime")).toBe(53);
    expect(parseRuntimeVersionNumber("v7")).toBe(7);
  });

  it("returns null on unparseable versions so callers fail closed", () => {
    expect(parseRuntimeVersionNumber("")).toBeNull();
    expect(parseRuntimeVersionNumber("53-no-prefix")).toBeNull();
    expect(parseRuntimeVersionNumber("vNaN")).toBeNull();
    expect(parseRuntimeVersionNumber("release-v53")).toBeNull();
  });

  it("keeps the floor itself parseable-shaped", () => {
    expect(Number.isInteger(MIN_COMPATIBLE_RUNTIME_VERSION)).toBe(true);
    expect(MIN_COMPATIBLE_RUNTIME_VERSION).toBeGreaterThan(0);
  });
});
