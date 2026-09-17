import { describe, expect, it } from "vitest";
import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import {
  activeBuildScopeKeys,
  currentFingerprintBuilds,
  excludeOtherProviderBuilds,
  excludeSupersededBuilds,
  foldEnabledRepoScopeIds,
  foldImageBuildStatusByScope,
  IMAGE_BUILD_IDLE_POLL_INTERVAL_MS,
  IMAGE_BUILD_POLL_INTERVAL_MS,
  imageBuildPollInterval,
  imageBuildScopeKey,
  imageBuildEnabledRepoViewSchema,
  imageBuildsEnabledReposResponseSchema,
  imageBuildsEnabledResponseSchema,
  imageBuildUnitViewSchema,
  latestCurrentBuildsByScope,
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
    ...overrides,
  };
}

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

describe("excludeOtherProviderBuilds", () => {
  it("keeps only the active provider's rows", () => {
    const rows = [
      record({ id: "a", provider: "modal" }),
      record({ id: "b", provider: "e2b" }),
      record({ id: "c", provider: "modal" }),
    ];

    expect(excludeOtherProviderBuilds(rows, "modal").map((row) => row.id)).toEqual(["a", "c"]);
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

  it("falls back to the unfiltered fold for a scope missing from units", () => {
    const folded = foldImageBuildStatusByScope(
      [
        record({ id: "a", status: "ready", repositoriesFingerprint: "fp-stale" }),
        record({ id: "b", status: "failed", repositoriesFingerprint: "fp-other" }),
      ],
      []
    );

    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("ready");
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
      imageBuildUnitViewSchema.safeParse({
        scopeKind: "environment",
        scopeId: "env_1",
        repositoriesFingerprint: "fp-current",
      }).success
    ).toBe(true);
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

describe("currentFingerprintBuilds", () => {
  it("drops stale-fingerprint rows and preserves feed order", () => {
    const rows = currentFingerprintBuilds(
      [
        record({ id: "a", repositoriesFingerprint: "fp-stale" }),
        record({ id: "b", repositoriesFingerprint: "fp-current" }),
        record({ id: "c", repositoriesFingerprint: "fp-current" }),
      ],
      [unit()]
    );

    expect(rows.map((row) => row.id)).toEqual(["b", "c"]);
  });

  it("keeps every row of a scope missing from units", () => {
    const rows = currentFingerprintBuilds(
      [record({ id: "a", repositoriesFingerprint: "fp-anything" })],
      []
    );

    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });
});

describe("latestCurrentBuildsByScope", () => {
  it("skips a newer stale-fingerprint row in favor of the newest current one", () => {
    // Feed order is createdAt DESC: the stale ready row is newest overall.
    const latest = latestCurrentBuildsByScope(
      [
        record({ id: "stale-newest", status: "ready", repositoriesFingerprint: "fp-stale" }),
        record({ id: "current-failed", status: "failed" }),
        record({ id: "current-older", status: "ready" }),
      ],
      [unit()]
    );

    expect(latest.get(imageBuildScopeKey("environment", "env-1"))?.id).toBe("current-failed");
  });

  it("maps each scope to its own newest row", () => {
    const latest = latestCurrentBuildsByScope(
      [
        record({ id: "repo-newest", scopeKind: "repo", scopeId: "acme/web" }),
        record({ id: "env-newest" }),
        record({ id: "env-older" }),
      ],
      []
    );

    expect(latest.get(imageBuildScopeKey("repo", "acme/web"))?.id).toBe("repo-newest");
    expect(latest.get(imageBuildScopeKey("environment", "env-1"))?.id).toBe("env-newest");
  });

  it("has no entry for a scope without countable rows", () => {
    const latest = latestCurrentBuildsByScope(
      [record({ id: "stale-only", repositoriesFingerprint: "fp-stale" })],
      [unit()]
    );

    expect(latest.get(imageBuildScopeKey("environment", "env-1"))).toBeUndefined();
  });
});

describe("activeBuildScopeKeys", () => {
  it("includes scopes with a building row under any fingerprint", () => {
    // The control plane's trigger guard is not fingerprint-scoped, so a
    // stale-fingerprint building row still blocks a new trigger.
    const active = activeBuildScopeKeys([
      record({ id: "stale-building", status: "building", repositoriesFingerprint: "fp-stale" }),
      record({ id: "repo-ready", scopeKind: "repo", scopeId: "acme/web", status: "ready" }),
    ]);

    expect(active.has(imageBuildScopeKey("environment", "env-1"))).toBe(true);
    expect(active.has(imageBuildScopeKey("repo", "acme/web"))).toBe(false);
  });
});
