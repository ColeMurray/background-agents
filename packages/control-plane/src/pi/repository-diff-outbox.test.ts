import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import type { SessionDiffUpload } from "@open-inspect/shared/types/session-diffs";
import {
  PermanentRepositoryDiffPublicationError,
  RepositoryDiffOutbox,
} from "./repository-diff-outbox";
import { applyPiDoMigrations } from "./schema";

const SHA = "a".repeat(40);

function bundle(path: string): SessionDiffUpload {
  return {
    version: 1,
    triggerMessageId: null,
    capturedAt: 1,
    repositories: [
      {
        status: "ready",
        position: 0,
        repoOwner: "group/subgroup",
        repoName: "shared",
        baseSha: SHA,
        headSha: SHA,
        truncated: false,
        omittedFileCount: 0,
        files: [
          {
            id: `pi-0-${path.replaceAll(".", "-")}`,
            path,
            status: "added",
            additions: 1,
            deletions: 0,
            renderState: "renderable",
            oldMode: "000000",
            newMode: "100644",
            patch: `diff --git a/${path} b/${path}\n+x`,
          },
        ],
      },
    ],
  };
}

function outbox(now: () => number = () => 100) {
  const database = new DatabaseSync(":memory:");
  const sql = createNodeSqlStorage(database).sql;
  applyPiDoMigrations(sql);
  return new RepositoryDiffOutbox(sql, now);
}

describe("RepositoryDiffOutbox", () => {
  it("retains the last successful bundle while a newer publication is pending", async () => {
    const box = outbox();
    const first = bundle("first.txt");
    const second = bundle("second.txt");
    await box.stage(first);
    await expect(box.drain(vi.fn(async () => undefined))).resolves.toBe("published");
    await box.stage(second);

    await expect(
      box.drain(vi.fn(async () => Promise.reject(new Error("provider down"))))
    ).resolves.toBe("pending");

    expect(box.state()).toMatchObject({
      pending: second,
      lastSuccessful: first,
      lastError: { message: "provider down", occurredAt: 100 },
    });
  });

  it("coalesces repeated pending bundles and records capture failures durably", async () => {
    const box = outbox();
    await box.stage(bundle("first.txt"));
    await box.stage(bundle("latest.txt"));
    box.recordCaptureFailure(new Error("assembly failed"));
    const publish = vi.fn(async () => undefined);

    await expect(box.drain(publish)).resolves.toBe("pending");

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        ...bundle("latest.txt"),
        publicationGeneration: 2,
      }),
      expect.any(AbortSignal)
    );
    expect(box.state()).toMatchObject({
      pending: null,
      recaptureRequired: true,
      lastSuccessful: bundle("latest.txt"),
      lastError: { message: "assembly failed" },
    });
    await box.stage(bundle("recaptured.txt"));
    await expect(box.drain(publish)).resolves.toBe("published");
  });

  it("survives eviction and a 24-hour publication outage without losing the previous bundle", async () => {
    const database = new DatabaseSync(":memory:");
    const sql = createNodeSqlStorage(database).sql;
    applyPiDoMigrations(sql);
    let now = 0;
    const first = new RepositoryDiffOutbox(sql, () => now);
    const previous = bundle("previous.txt");
    first.stage(previous);
    await first.drain(async () => undefined);
    const pending = bundle("pending.txt");
    first.stage(pending);
    const outage = vi.fn(async () => Promise.reject(new Error("publication unavailable")));

    for (let minute = 0; minute < 24 * 60; minute++) {
      now = minute * 60_000;
      await first.drain(outage);
    }
    const reopened = new RepositoryDiffOutbox(sql, () => now);

    expect(reopened.state()).toMatchObject({
      pending,
      lastSuccessful: previous,
      lastError: { message: "publication unavailable" },
    });
    await expect(reopened.drain(async () => undefined)).resolves.toBe("published");
    expect(reopened.state()).toMatchObject({ pending: null, lastSuccessful: pending });
    database.close();
  });

  it("serializes deferred A publication ahead of staging and publishing B", async () => {
    const box = outbox();
    const remote: string[] = [];
    let releaseA!: () => void;
    let markAStarted!: () => void;
    const aGate = new Promise<void>((resolve) => (releaseA = resolve));
    const aStarted = new Promise<void>((resolve) => (markAStarted = resolve));
    await box.stage(bundle("a.txt"));
    const publishA = box.drain(async (value) => {
      const path =
        value.repositories[0]?.status === "ready" ? value.repositories[0].files[0]?.path : null;
      if (path === "a.txt") {
        markAStarted();
        await aGate;
      }
      remote.push(path === "a.txt" ? "a" : "b");
    });
    await aStarted;

    await box.stage(bundle("b.txt"));
    await expect(box.drain(async () => undefined)).resolves.toBe("pending");
    expect(remote).toEqual([]);
    releaseA();

    await publishA;
    expect(remote).toEqual(["a", "b"]);
    expect(box.state()).toMatchObject({ pending: null, lastSuccessful: bundle("b.txt") });
  });

  it("retains recapture-required when B capture fails while A is pending", async () => {
    const box = outbox();
    await box.stage(bundle("a.txt"));
    await box.recordCaptureFailure(new Error("capture B failed"));

    await expect(box.drain(async () => undefined)).resolves.toBe("pending");

    expect(box.state()).toMatchObject({
      pending: null,
      recaptureRequired: true,
      lastSuccessful: bundle("a.txt"),
      lastError: { message: "capture B failed" },
    });
  });

  it("bounds deterministic permanent failures and stops retrying the rejected bundle", async () => {
    const box = outbox();
    await box.stage(bundle("bad.txt"));

    await expect(
      box.drain(async () => {
        throw new PermanentRepositoryDiffPublicationError("x".repeat(5_000));
      })
    ).resolves.toBe("permanent");

    expect(box.state()).toMatchObject({
      pending: null,
      recaptureRequired: false,
      permanentError: expect.stringMatching(/^x{2000}$/),
    });
    const publish = vi.fn(async () => undefined);
    await expect(box.drain(publish)).resolves.toBe("permanent");
    expect(publish).not.toHaveBeenCalled();
  });

  it("bounds a hung publication with the TypeScript millisecond deadline", async () => {
    const database = new DatabaseSync(":memory:");
    const sql = createNodeSqlStorage(database).sql;
    applyPiDoMigrations(sql);
    const box = new RepositoryDiffOutbox(sql, () => 100, 5);
    await box.stage(bundle("slow.txt"));

    await expect(
      box.drain(
        (_value, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          })
      )
    ).resolves.toBe("pending");

    expect(box.state().lastError).toMatchObject({ message: expect.stringMatching(/timed out/i) });
    database.close();
  });

  it("manual recapture advances generation and clears a permanent marker", async () => {
    const box = outbox();
    await box.stage(bundle("bad.txt"));
    await box.drain(async () => {
      throw new PermanentRepositoryDiffPublicationError("contract rejected");
    });
    const before = box.state().generation;

    await expect(box.requestRecapture()).resolves.toBe(before + 1);

    expect(box.state()).toMatchObject({
      generation: before + 1,
      recaptureRequired: true,
      permanentError: null,
    });
  });
});
