import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type * as SlackModule from "@open-inspect/shared/slack";
import { postBlocks } from "@open-inspect/shared/slack";
import { ProjectStore } from "../db/project-store";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { IntegrationSettingsStore } from "../db/integration-settings";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { projectViewer } from "./project-context";
import { notifyProjectCompletion } from "./project-notifications";
vi.mock("@open-inspect/shared/slack", async (original) => ({
  ...(await original<typeof SlackModule>()),
  postBlocks: vi.fn(),
}));
vi.mock("./project-context", () => ({ projectViewer: vi.fn() }));
const db = {} as SqlDatabase;
const env = { SLACK_BOT_TOKEN: "test-token", WEB_APP_URL: "https://app.test" } as Env;
const session: SessionEntry = {
  id: "s",
  userId: "owner",
  projectId: "p",
  visibility: "workspace",
  spawnSource: "user",
  title: "SECRET TITLE",
  repoOwner: null,
  repoName: null,
  model: "anthropic/claude-haiku-4-5",
  reasoningEffort: null,
  baseBranch: null,
  status: "completed",
  ownerTeamId: null,
  createdAt: 1,
  updatedAt: 1,
};
describe("project completion notification privacy and idempotency", () => {
  beforeEach(() => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue(session);
    vi.spyOn(ProjectStore.prototype, "get").mockResolvedValue({
      id: "p",
      ownerUserId: "owner",
      ownerTeamId: null,
      primarySlackChannelId: "C123",
    } as Awaited<ReturnType<ProjectStore["get"]>>);
    vi.spyOn(IntegrationSettingsStore.prototype, "getGlobal").mockResolvedValue({
      defaults: { agentNotificationsEnabled: true },
    } as NonNullable<Awaited<ReturnType<IntegrationSettingsStore["getGlobal"]>>>);
    vi.mocked(projectViewer).mockResolvedValue({
      kind: "user",
      userId: "owner",
      roleKey: "member",
      permissions: ["projects.read"],
      memberships: new Map(),
      suspended: false,
    });
    vi.mocked(postBlocks).mockResolvedValue({ ok: true, channel: "C123", ts: "123" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  it("posts only fixed metadata after a successful claim", async () => {
    const claim = vi.fn(() => true);
    expect(await notifyProjectCompletion(db, env, "s", "m", true, claim)).toBe(true);
    expect(claim).toHaveBeenCalledOnce();
    expect(postBlocks).toHaveBeenCalledWith(
      "test-token",
      "C123",
      expect.any(Array),
      expect.any(Object)
    );
    expect(JSON.stringify(vi.mocked(postBlocks).mock.calls)).not.toContain("SECRET TITLE");
    expect(await notifyProjectCompletion(db, env, "s", "m", true, () => false)).toBe(false);
    expect(postBlocks).toHaveBeenCalledOnce();
  });
  it.each([{ visibility: "private" }, { spawnSource: "slack-bot" }, { projectId: null }])(
    "does not post for excluded sessions: %j",
    async (override) => {
      vi.mocked(SessionIndexStore.prototype.get).mockResolvedValue({
        ...session,
        ...override,
      } as SessionEntry);
      const claim = vi.fn(() => true);
      expect(await notifyProjectCompletion(db, env, "s", "m", true, claim)).toBe(false);
      expect(claim).not.toHaveBeenCalled();
      expect(postBlocks).not.toHaveBeenCalled();
    }
  );
  it("does not post after the owner loses project access", async () => {
    vi.mocked(projectViewer).mockResolvedValue({
      kind: "user",
      userId: "owner",
      roleKey: null,
      permissions: [],
      memberships: new Map(),
      suspended: true,
    });
    expect(await notifyProjectCompletion(db, env, "s", "m", true, () => true)).toBe(false);
    expect(postBlocks).not.toHaveBeenCalled();
  });
});
