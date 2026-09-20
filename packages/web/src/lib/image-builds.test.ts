import { describe, expect, it } from "vitest";
import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import {
  excludeOtherProviderBuilds,
  excludeSupersededBuilds,
  foldEnabledRepoScopeIds,
  foldImageBuildStatusByScope,
  IMAGE_BUILD_IDLE_POLL_INTERVAL_MS,
  IMAGE_BUILD_POLL_INTERVAL_MS,
  imageBuildPollInterval,
  imageBuildScopeKey,
  selectCurrentImageBuild,
  imageBuildEnabledRepoViewSchema,
  imageBuildsEnabledReposResponseSchema,
  imageBuildsEnabledResponseSchema,
  imageBuildUnitViewSchema,
  parsePrimaryBuildSha,
  repoImageBuildScopeId,
  type ImageBuildUnitView,
} from "./image-builds";

function record(overrides: Partial<ImageBuildRecordView>): ImageBuildRecordView {
  return {
    id: "build-1",
    scopeKind: "environment",
    scopeId: "env-1",
    provider: "modal",
    executionProfile: "default",
    status: "ready",
    repositoriesFingerprint: "fp-current",
    repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
    runtimeVersion: "60",
    buildDurationSeconds: 42,
    errorMessage: null,
    createdAt: 1700000000000,
    ...overrides,
  };
}

function unit(overrides: Partial<ImageBuildUnitView> = {}): ImageBuildUnitView {
  return {
    scopeKind: "environment",
    scopeId: "env-1",
    repositoriesFingerprint: "fp-current",
    executionProfile: "default",
    ...overrides,
  };
}

describe("excludeOtherProviderBuilds", () => {
  it("keeps only rows this deployment's provider could actually boot", () => {
    const rows = [
      record({ id: "a", provider: "daytona", status: "ready" }),
      record({ id: "b", provider: "modal", status: "ready" }),
    ];

    // A retained row from a previous provider is history the reaper still
    // needs; presenting it as this deployment's prebuild would promise a boot
    // spawn selection will never perform.
    expect(excludeOtherProviderBuilds(rows, "daytona").map((row) => row.id)).toEqual(["a"]);
    expect(excludeOtherProviderBuilds(rows, "vercel")).toEqual([]);
  });
});

describe("excludeSupersededBuilds", () => {
  it("drops superseded rows and keeps every other status", () => {
    const rows = [
      record({ id: "a", status: "ready" }),
      record({ id: "b", status: "superseded" }),
      record({ id: "c", status: "building" }),
      record({ id: "d", status: "failed" }),
    ];

    expect(excludeSupersededBuilds(rows).map((row) => row.id)).toEqual(["a", "c", "d"]);
  });
});

describe("foldImageBuildStatusByScope", () => {
  it("folds a failed-only scope to failed (visible in the aggregate)", () => {
    const folded = foldImageBuildStatusByScope([record({ status: "failed" })], [unit()]);

    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("failed");
  });

  it("ready beats building beats failed regardless of row order", () => {
    const folded = foldImageBuildStatusByScope(
      [
        record({ id: "a", status: "failed", scopeId: "env-ready" }),
        record({ id: "b", status: "building", scopeId: "env-ready" }),
        record({ id: "c", status: "ready", scopeId: "env-ready" }),
        record({ id: "d", status: "failed", scopeId: "env-building" }),
        record({ id: "e", status: "building", scopeId: "env-building" }),
      ],
      [unit({ scopeId: "env-ready" }), unit({ scopeId: "env-building" })]
    );

    expect(folded.get(imageBuildScopeKey("environment", "env-ready"))).toBe("ready");
    expect(folded.get(imageBuildScopeKey("environment", "env-building"))).toBe("building");
  });

  it("folds repo and environment scopes independently", () => {
    const folded = foldImageBuildStatusByScope(
      [
        record({ id: "a", scopeKind: "repo", scopeId: "acme/web", status: "failed" }),
        record({ id: "b", scopeKind: "environment", scopeId: "env-1", status: "ready" }),
      ],
      [unit({ scopeKind: "repo", scopeId: "acme/web" }), unit()]
    );

    expect(folded.get(imageBuildScopeKey("repo", "acme/web"))).toBe("failed");
    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("ready");
  });

  it("folds to failed when only a stale-fingerprint ready row outranks the failed current build", () => {
    const folded = foldImageBuildStatusByScope(
      [
        record({ id: "a", status: "ready", repositoriesFingerprint: "fp-stale" }),
        record({ id: "b", status: "failed", repositoriesFingerprint: "fp-current" }),
      ],
      [unit()]
    );

    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("failed");
  });

  it("folds to ready when the ready row carries the current fingerprint", () => {
    const folded = foldImageBuildStatusByScope(
      [
        record({ id: "a", status: "ready", repositoriesFingerprint: "fp-current" }),
        record({ id: "b", status: "failed", repositoriesFingerprint: "fp-stale" }),
      ],
      [unit()]
    );

    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("ready");
  });

  it("omits status for a scope missing from the configured units", () => {
    const folded = foldImageBuildStatusByScope(
      [
        record({ id: "a", status: "ready", repositoriesFingerprint: "fp-stale" }),
        record({ id: "b", status: "failed", repositoriesFingerprint: "fp-other" }),
      ],
      []
    );

    expect(folded.has(imageBuildScopeKey("environment", "env-1"))).toBe(false);
  });

  it("folds only the configured execution profile unless the session overrides it", () => {
    const rows = [
      record({ id: "default-ready", executionProfile: "default", status: "ready" }),
      record({ id: "docker-building", executionProfile: "docker-v1", status: "building" }),
    ];
    const configuredDocker = [unit({ executionProfile: "docker-v1" })];

    expect(
      foldImageBuildStatusByScope(rows, configuredDocker).get(
        imageBuildScopeKey("environment", "env-1")
      )
    ).toBe("building");
    expect(
      foldImageBuildStatusByScope(rows, configuredDocker, "default").get(
        imageBuildScopeKey("environment", "env-1")
      )
    ).toBe("ready");
  });

  it("does not advertise a default ready image when configured Docker has failed", () => {
    const folded = foldImageBuildStatusByScope(
      [
        record({ id: "default-ready", executionProfile: "default", status: "ready" }),
        record({ id: "docker-failed", executionProfile: "docker-v1", status: "failed" }),
      ],
      [unit({ executionProfile: "docker-v1" })]
    );

    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("failed");
  });
});

describe("selectCurrentImageBuild", () => {
  it("selects only the configured profile and current fingerprint", () => {
    const current = record({ id: "docker-current", executionProfile: "docker-v1" });
    expect(
      selectCurrentImageBuild(
        [
          record({ id: "default-current" }),
          record({
            id: "docker-stale",
            executionProfile: "docker-v1",
            repositoriesFingerprint: "old",
          }),
          current,
        ],
        [unit({ executionProfile: "docker-v1" })],
        "environment",
        "env-1"
      )
    ).toEqual(current);
  });

  it("returns undefined without a resolved unit", () => {
    expect(selectCurrentImageBuild([record({})], [], "environment", "env-1")).toBeUndefined();
  });
});

describe("repoImageBuildScopeId", () => {
  it("lowercases owner/name to match the feed's repo scope keys", () => {
    expect(repoImageBuildScopeId("Acme", "Web")).toBe("acme/web");
  });
});

describe("foldEnabledRepoScopeIds", () => {
  it("folds the persisted flags to a set of lowercased scope ids", () => {
    const ids = foldEnabledRepoScopeIds([
      { repoOwner: "Acme", repoName: "Web" },
      { repoOwner: "acme", repoName: "api" },
    ]);

    expect(ids).toEqual(new Set(["acme/web", "acme/api"]));
  });

  it("returns an empty set for no flags", () => {
    expect(foldEnabledRepoScopeIds([])).toEqual(new Set());
  });
});

describe("image-build feed schemas", () => {
  it("parses valid unit and enabled-repo payloads", () => {
    expect(
      imageBuildUnitViewSchema.parse({
        scopeKind: "environment",
        scopeId: "env_1",
        repositoriesFingerprint: "fp-current",
      }).executionProfile
    ).toBe("default");
    expect(
      imageBuildEnabledRepoViewSchema.safeParse({ repoOwner: "acme", repoName: "web" }).success
    ).toBe(true);
  });

  it("rejects malformed or partial unit and enabled-repo payloads", () => {
    expect(
      imageBuildUnitViewSchema.safeParse({
        scopeKind: "workspace",
        scopeId: "env_1",
        repositoriesFingerprint: "fp-current",
      }).success
    ).toBe(false);
    expect(imageBuildEnabledRepoViewSchema.safeParse({ repoOwner: "acme" }).success).toBe(false);
    expect(
      imageBuildUnitViewSchema.safeParse({
        scopeKind: "environment",
        scopeId: "env_1",
        repositoriesFingerprint: "fp-current",
        executionProfile: "unknown",
      }).success
    ).toBe(false);
  });

  it("requires response arrays from the control-plane feed", () => {
    expect(imageBuildsEnabledResponseSchema.safeParse({}).success).toBe(false);
    expect(imageBuildsEnabledReposResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("parsePrimaryBuildSha", () => {
  it("reads the primary repository's baseSha", () => {
    const shas = [
      { repoOwner: "acme", repoName: "web", baseSha: "abc123def" },
      { repoOwner: "acme", repoName: "api", baseSha: "fff000" },
    ];

    expect(parsePrimaryBuildSha(shas)).toBe("abc123def");
  });

  it("returns null for an empty document", () => {
    expect(parsePrimaryBuildSha([])).toBeNull();
  });

  it("returns null for unavailable provenance", () => {
    expect(parsePrimaryBuildSha(null)).toBeNull();
  });
});

describe("imageBuildPollInterval", () => {
  it("polls fast while any row is still building", () => {
    const images = [record({ status: "ready" }), record({ id: "build-2", status: "building" })];

    expect(imageBuildPollInterval(images)).toBe(IMAGE_BUILD_POLL_INTERVAL_MS);
  });

  it("keeps a slow discovery poll on an all-terminal feed", () => {
    // Builds also start without any client action (cron scheduler, detached
    // save hooks), so a terminal feed must still discover new building rows.
    const images = [record({ status: "ready" }), record({ id: "build-2", status: "failed" })];

    expect(imageBuildPollInterval(images)).toBe(IMAGE_BUILD_IDLE_POLL_INTERVAL_MS);
  });

  it("keeps the slow discovery poll on an empty feed", () => {
    // The detached save hook can lose the race against the toggle response's
    // immediate mutate — an empty feed still has to discover the first build.
    expect(imageBuildPollInterval([])).toBe(IMAGE_BUILD_IDLE_POLL_INTERVAL_MS);
  });

  it("does not poll before the feed has loaded", () => {
    expect(imageBuildPollInterval(undefined)).toBe(0);
  });
});
