import { describe, expect, it, vi } from "vitest";
import {
  derivePromptTitle,
  generateTitle,
  runAutoRename,
  type AutoRenameDeps,
  type TitlerClient,
} from "./session-titler";
import type { SessionRow } from "../types";

describe("derivePromptTitle", () => {
  it("uses first non-empty line of plain prompt with no prefix for user spawnSource", () => {
    const out = derivePromptTitle("Fix the login bug\nRest of context here", "user");
    expect(out).toBe("Fix the login bug");
  });

  it("prefixes GitHub: for github-bot spawn", () => {
    const out = derivePromptTitle("Review PR #42 carefully", "github-bot");
    expect(out).toBe("GitHub: Review PR #42 carefully");
  });

  it("prefixes Slack: for slack-bot spawn", () => {
    const out = derivePromptTitle("Fix the deploy script", "slack-bot");
    expect(out).toBe("Slack: Fix the deploy script");
  });

  it("prefixes Linear: for linear-bot spawn", () => {
    const out = derivePromptTitle("Refactor session sidebar", "linear-bot");
    expect(out).toBe("Linear: Refactor session sidebar");
  });

  it("strips markdown formatting characters", () => {
    const out = derivePromptTitle("**Important**: fix `auth.ts` _now_", "user");
    expect(out).toBe("Important: fix auth.ts now");
  });

  it("strips code fences", () => {
    const out = derivePromptTitle("```\ncode here\n```\nFix the parser", "user");
    expect(out).toBe("Fix the parser");
  });

  it("strips URLs", () => {
    const out = derivePromptTitle("See https://example.com/foo for context, fix the bug", "user");
    expect(out).toContain("fix the bug");
    expect(out).not.toContain("https://");
  });

  it("collapses whitespace", () => {
    const out = derivePromptTitle("Fix     the      bug", "user");
    expect(out).toBe("Fix the bug");
  });

  it("truncates to <= 60 chars at word boundary with ellipsis when over 55", () => {
    const long =
      "This is a very long prompt that should definitely be truncated because it goes way over the limit";
    const out = derivePromptTitle(long, "user");
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).not.toMatch(/[a-z]$/i);
  });

  it("returns 'Untitled session' when prompt is entirely whitespace", () => {
    expect(derivePromptTitle("   \n\t  ", "user")).toBe("Untitled session");
  });

  it("returns 'Untitled session' when prompt is only URLs", () => {
    expect(derivePromptTitle("https://a.com https://b.com", "user")).toBe("Untitled session");
  });

  it("returns 'Untitled session' when prompt is only a code fence", () => {
    expect(derivePromptTitle("```\njust code\n```", "user")).toBe("Untitled session");
  });

  it("does not exceed 60 chars even with a long github-bot prefix", () => {
    const long = "a".repeat(200);
    const out = derivePromptTitle(long, "github-bot");
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.startsWith("GitHub: ")).toBe(true);
  });

  it("returns 'Untitled session' literal even when spawnSource has a prefix and prompt is empty", () => {
    expect(derivePromptTitle("   ", "github-bot")).toBe("Untitled session");
  });

  it("preserves > characters that are not at line start (comparisons, redirects)", () => {
    expect(derivePromptTitle("Fix x > y comparison", "user")).toBe("Fix x > y comparison");
    expect(derivePromptTitle("Use cmd > out.txt", "user")).toBe("Use cmd > out.txt");
  });

  it("preserves underscores in identifiers (snake_case)", () => {
    expect(derivePromptTitle("Fix the my_var_name handling", "user")).toBe(
      "Fix the my_var_name handling"
    );
  });

  it("strips leading blockquote markers", () => {
    expect(derivePromptTitle("> quote line\nFix the bug", "user")).toBe("quote line");
  });
});

function makeMockClient(toolInput: unknown, content?: unknown): TitlerClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: content ?? [{ type: "tool_use", name: "set_session_title", input: toolInput }],
      }),
    },
  } as unknown as TitlerClient;
}

describe("generateTitle", () => {
  it("returns the title from a well-formed tool_use block", async () => {
    const client = makeMockClient({ title: "GitHub: Fix flaky tests" });
    const out = await generateTitle({
      client,
      prompt: "Please fix the flaky tests",
      spawnSource: "github-bot",
    });
    expect(out).toBe("GitHub: Fix flaky tests");
  });

  it("returns null when there is no tool_use block", async () => {
    const client = makeMockClient(undefined, [{ type: "text", text: "I refuse" }]);
    const out = await generateTitle({
      client,
      prompt: "Anything",
      spawnSource: "user",
    });
    expect(out).toBeNull();
  });

  it("returns null when tool input is missing the title field", async () => {
    const client = makeMockClient({});
    const out = await generateTitle({
      client,
      prompt: "Anything",
      spawnSource: "user",
    });
    expect(out).toBeNull();
  });

  it("returns null when title is empty/whitespace", async () => {
    const client = makeMockClient({ title: "   " });
    const out = await generateTitle({
      client,
      prompt: "Anything",
      spawnSource: "user",
    });
    expect(out).toBeNull();
  });

  it("trims, collapses whitespace, and hard-truncates titles over 60 chars", async () => {
    const client = makeMockClient({
      title:
        "  GitHub:    Fix  the  very    long  title that exceeds the maximum allowed length easily  ",
    });
    const out = await generateTitle({
      client,
      prompt: "Anything",
      spawnSource: "github-bot",
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(60);
    expect(out!).toMatch(/^GitHub:/);
  });

  it("returns null when the underlying client throws (network error)", async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("network")),
      },
    } as unknown as TitlerClient;
    const out = await generateTitle({
      client,
      prompt: "Anything",
      spawnSource: "user",
    });
    expect(out).toBeNull();
  });

  it("returns null when client is null (no API key configured)", async () => {
    const out = await generateTitle({
      client: null,
      prompt: "Anything",
      spawnSource: "user",
    });
    expect(out).toBeNull();
  });
});

function baseSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-public-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 1,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    title_manually_set: 0,
    title_auto_rename_attempted_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AutoRenameDeps> = {}): AutoRenameDeps {
  return {
    repository: {
      getSession: vi.fn().mockReturnValue(baseSession()),
      updateSessionTitle: vi.fn(),
      markTitleAutoRenameAttempted: vi.fn(),
    },
    titler: vi.fn().mockResolvedValue("GitHub: Fix flaky tests"),
    syncSessionIndexTitle: vi.fn(),
    broadcast: vi.fn(),
    getPublicSessionId: vi.fn().mockReturnValue("session-public-1"),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    now: () => 12345,
    ...overrides,
  };
}

describe("runAutoRename", () => {
  it("marks attempted before calling titler (so a crash mid-call doesn't retry)", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      titler: vi.fn().mockImplementation(async () => {
        calls.push("titler");
        return "Some title";
      }),
      repository: {
        getSession: vi.fn().mockReturnValue(baseSession()),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn().mockImplementation(() => calls.push("mark")),
      },
    });
    await runAutoRename({ deps, prompt: "p" });
    expect(calls.indexOf("mark")).toBeLessThan(calls.indexOf("titler"));
  });

  it("does nothing when title_manually_set is 1", async () => {
    const deps = makeDeps({
      repository: {
        getSession: vi.fn().mockReturnValue(baseSession({ title_manually_set: 1 })),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "p" });
    expect(deps.titler).not.toHaveBeenCalled();
    expect(deps.repository.updateSessionTitle).not.toHaveBeenCalled();
    expect(deps.repository.markTitleAutoRenameAttempted).not.toHaveBeenCalled();
  });

  it("does nothing when title_auto_rename_attempted_at is set", async () => {
    const deps = makeDeps({
      repository: {
        getSession: vi.fn().mockReturnValue(baseSession({ title_auto_rename_attempted_at: 1 })),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "p" });
    expect(deps.titler).not.toHaveBeenCalled();
    expect(deps.repository.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("writes Haiku title when titler returns and existing title is null", async () => {
    const deps = makeDeps({
      titler: vi.fn().mockResolvedValue("GitHub: Fix flaky tests"),
      repository: {
        getSession: vi
          .fn()
          .mockReturnValueOnce(baseSession({ title: null }))
          .mockReturnValueOnce(baseSession({ title: null })),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "fix the bug" });
    expect(deps.repository.updateSessionTitle).toHaveBeenCalledWith(
      "session-1",
      "GitHub: Fix flaky tests",
      12345
    );
    expect(deps.syncSessionIndexTitle).toHaveBeenCalledWith(
      "session-public-1",
      "GitHub: Fix flaky tests"
    );
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: "session_title",
      title: "GitHub: Fix flaky tests",
    });
  });

  it("writes Haiku title and overwrites a non-empty existing bot default", async () => {
    const deps = makeDeps({
      titler: vi.fn().mockResolvedValue("GitHub: Fix flaky tests"),
      repository: {
        getSession: vi
          .fn()
          .mockReturnValueOnce(baseSession({ title: "GitHub: Review PR #8" }))
          .mockReturnValueOnce(baseSession({ title: "GitHub: Review PR #8" })),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "fix the bug" });
    expect(deps.repository.updateSessionTitle).toHaveBeenCalledWith(
      "session-1",
      "GitHub: Fix flaky tests",
      12345
    );
  });

  it("falls back to derivePromptTitle when titler returns null AND existing title is null", async () => {
    const deps = makeDeps({
      titler: vi.fn().mockResolvedValue(null),
      repository: {
        getSession: vi
          .fn()
          .mockReturnValueOnce(baseSession({ title: null }))
          .mockReturnValueOnce(baseSession({ title: null })),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "Add tests for the parser" });
    const writtenTitle = (deps.repository.updateSessionTitle as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(writtenTitle).toBe("Add tests for the parser");
  });

  it("preserves existing non-empty title when titler returns null (no downgrade)", async () => {
    const deps = makeDeps({
      titler: vi.fn().mockResolvedValue(null),
      repository: {
        getSession: vi
          .fn()
          .mockReturnValueOnce(baseSession({ title: "GitHub: Review PR #8" }))
          .mockReturnValueOnce(baseSession({ title: "GitHub: Review PR #8" })),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "anything" });
    expect(deps.repository.updateSessionTitle).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("writes 'Untitled session' when titler null AND prompt is whitespace AND title null (the load-bearing invariant)", async () => {
    const deps = makeDeps({
      titler: vi.fn().mockResolvedValue(null),
      repository: {
        getSession: vi
          .fn()
          .mockReturnValueOnce(baseSession({ title: null }))
          .mockReturnValueOnce(baseSession({ title: null })),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "   \n\t  " });
    expect(deps.repository.updateSessionTitle).toHaveBeenCalledWith(
      "session-1",
      "Untitled session",
      12345
    );
  });

  it("re-checks title_manually_set after the Haiku call returns and skips the write if true", async () => {
    let callCount = 0;
    const deps = makeDeps({
      titler: vi.fn().mockResolvedValue("Haiku title"),
      repository: {
        getSession: vi.fn().mockImplementation(() => {
          callCount += 1;
          if (callCount === 1) return baseSession({ title: null, title_manually_set: 0 });
          return baseSession({ title: "User chose this", title_manually_set: 1 });
        }),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "p" });
    expect(deps.repository.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("returns silently if session is missing on the pre-call read", async () => {
    const deps = makeDeps({
      repository: {
        getSession: vi.fn().mockReturnValue(null),
        updateSessionTitle: vi.fn(),
        markTitleAutoRenameAttempted: vi.fn(),
      },
    });
    await runAutoRename({ deps, prompt: "p" });
    expect(deps.titler).not.toHaveBeenCalled();
    expect(deps.repository.updateSessionTitle).not.toHaveBeenCalled();
  });
});
