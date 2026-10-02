import { describe, expect, it } from "vitest";
import { buildInjectionBlock, buildToolResult, projectBoardLane } from "./project-context";
import type { ProjectContextInput } from "./project-context";

const input = (): ProjectContextInput => ({
  project: { id: "proj_test", slug: "test", name: "Test", status: "active", brief: "A brief" },
  decisions: [],
  links: [],
  sources: [],
  sessions: [],
  memories: [],
  sessionRepositories: [],
});
const bytes = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;

describe("project context acceptance", () => {
  it("caps UTF-8 injection, labels data and records every included source", async () => {
    const value = input();
    value.project.brief = "🧑‍💻".repeat(6000);
    const result = await buildInjectionBlock(value);
    expect(bytes(result.text)).toBeLessThanOrEqual(12_000);
    expect(result.text).toContain("untrusted project data");
    expect(result.text).toContain("read_project_context");
    expect(result.text).not.toContain("�");
    expect(result.manifest.truncated).toContain("brief");
    expect(result.manifest.briefSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never includes page-only references or their identifiers in either channel", async () => {
    const value = input();
    value.sources = [
      {
        id: "hidden",
        sourceType: "url",
        externalIdOrUrl: "https://secret.example",
        role: "reference",
        visibility: "page_only",
        position: 0,
      },
    ];
    expect(JSON.stringify(await buildInjectionBlock(value))).not.toContain("hidden");
    expect(JSON.stringify(buildToolResult(value))).not.toContain("secret.example");
  });

  it("accounts for JSON escaping and caps the complete tool result and session window", () => {
    const value = input();
    value.project.brief = '\\"\n'.repeat(20_000);
    value.sessions = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      title: "🦊".repeat(4000),
      status: "active",
      target: "a/b",
      pullRequests: [],
      updatedAt: i,
    }));
    const result = buildToolResult(value);
    expect(bytes(result)).toBeLessThanOrEqual(65_536);
    expect(result.budget.bytes).toBe(bytes(result));
    expect(result.sessions.length).toBeLessThanOrEqual(20);
    expect(result.budget.truncated).toContain("sessions");
    expect(result.budget.truncated).toContain("brief");
  });

  it("requires a matching repository for workspace fetchability, including nested owners", () => {
    const value = input();
    value.sources = [
      {
        id: "doc",
        sourceType: "repo_doc",
        externalIdOrUrl: "group/sub/repo:docs/a.md",
        role: "reference",
        visibility: "agent",
        position: 0,
      },
    ];
    expect(buildToolResult(value).sources[0].fetchable).toEqual({
      how: "none",
      reason: "repo_not_in_session",
    });
    value.sessionRepositories = [{ owner: "group/sub", name: "repo" }];
    expect(buildToolResult(value).sources[0].fetchable).toEqual({ how: "workspace" });
  });
});

describe("project board lanes", () => {
  it.each([
    [[], "no_pr"],
    [[{ state: "open", isDraft: true }], "draft"],
    [
      [
        { state: "open", isDraft: false },
        { state: "open", isDraft: true },
      ],
      "open",
    ],
    [
      [
        { state: "merged", isDraft: false },
        { state: "closed", isDraft: false },
      ],
      "merged",
    ],
    [[{ state: "closed", isDraft: true }], "closed"],
  ] as const)("derives %j as %s", (prs, lane) => expect(projectBoardLane(prs)).toBe(lane));
});
