/**
 * Tests for ArtifactRepository implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";
import { createArtifactRepository } from "./artifact-repository";
import { initSchema } from "../schema";
import type { ArtifactRepository } from "./types";

describe("ArtifactRepository", () => {
  let sql: FakeSqlStorage;
  let repo: ArtifactRepository;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    initSchema(sql as unknown as SqlStorage);
    repo = createArtifactRepository(sql as unknown as SqlStorage);
  });

  describe("create", () => {
    it("should create a new artifact with required fields", () => {
      const now = Date.now();
      const artifact = repo.create({
        id: "artifact-1",
        type: "pr",
        createdAt: now,
      });

      expect(artifact.id).toBe("artifact-1");
      expect(artifact.type).toBe("pr");
      expect(artifact.created_at).toBe(now);
      expect(artifact.url).toBeNull();
      expect(artifact.metadata).toBeNull();
    });

    it("should create an artifact with URL", () => {
      const artifact = repo.create({
        id: "artifact-1",
        type: "pr",
        url: "https://github.com/owner/repo/pull/123",
        createdAt: Date.now(),
      });

      expect(artifact.url).toBe("https://github.com/owner/repo/pull/123");
    });

    it("should create an artifact with metadata", () => {
      const metadata = JSON.stringify({ number: 123, merged: false });
      const artifact = repo.create({
        id: "artifact-1",
        type: "pr",
        metadata,
        createdAt: Date.now(),
      });

      expect(artifact.metadata).toBe(metadata);
    });

    it("should create an artifact with URL and metadata", () => {
      const url = "https://github.com/owner/repo/pull/123";
      const metadata = JSON.stringify({ number: 123 });

      const artifact = repo.create({
        id: "artifact-1",
        type: "pr",
        url,
        metadata,
        createdAt: Date.now(),
      });

      expect(artifact.url).toBe(url);
      expect(artifact.metadata).toBe(metadata);
    });
  });

  describe("getById", () => {
    it("should return null when artifact does not exist", () => {
      const artifact = repo.getById("nonexistent");
      expect(artifact).toBeNull();
    });

    it("should return artifact when it exists", () => {
      repo.create({
        id: "artifact-1",
        type: "pr",
        createdAt: Date.now(),
      });

      const artifact = repo.getById("artifact-1");
      expect(artifact).not.toBeNull();
      expect(artifact?.id).toBe("artifact-1");
    });
  });

  describe("list", () => {
    it("should return empty array when no artifacts exist", () => {
      const artifacts = repo.list();
      expect(artifacts).toEqual([]);
    });

    it("should return all artifacts", () => {
      repo.create({
        id: "artifact-1",
        type: "pr",
        createdAt: Date.now() - 2000,
      });
      repo.create({
        id: "artifact-2",
        type: "screenshot",
        createdAt: Date.now() - 1000,
      });
      repo.create({
        id: "artifact-3",
        type: "preview",
        createdAt: Date.now(),
      });

      const artifacts = repo.list();
      expect(artifacts).toHaveLength(3);
    });

    it("should return artifacts ordered by created_at descending (newest first)", () => {
      const now = Date.now();
      repo.create({
        id: "artifact-1",
        type: "pr",
        createdAt: now - 2000,
      });
      repo.create({
        id: "artifact-2",
        type: "screenshot",
        createdAt: now - 1000,
      });
      repo.create({
        id: "artifact-3",
        type: "preview",
        createdAt: now,
      });

      const artifacts = repo.list();
      expect(artifacts[0].id).toBe("artifact-3");
      expect(artifacts[1].id).toBe("artifact-2");
      expect(artifacts[2].id).toBe("artifact-1");
    });
  });
});
