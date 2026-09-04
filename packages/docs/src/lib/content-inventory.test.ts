import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const contentRoot = resolve(process.cwd(), "content/docs");

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function routeFor(path: string): string {
  const route = relative(contentRoot, path)
    .split(sep)
    .join("/")
    .replace(/\.mdx$/, "");
  return route === "index" ? "/" : `/${route.replace(/\/index$/, "")}`;
}

const contentFiles = walk(contentRoot).filter((path) => extname(path) === ".mdx");
const publicRoutes = new Set(contentFiles.map(routeFor));

describe("public documentation inventory", () => {
  it("publishes the complete MVP route set", () => {
    expect([...publicRoutes].sort()).toEqual(
      [
        "/",
        "/concepts/how-a-session-works",
        "/concepts/what-is-background-agents",
        "/configure/models-providers-and-secrets",
        "/configure/repositories-and-environments",
        "/getting-started/first-task",
        "/getting-started/quickstart",
        "/guides/choose-and-specify-work",
        "/guides/monitor-and-steer",
        "/guides/recover-from-failed-run",
        "/guides/review-evidence-and-changes",
        "/integrations",
        "/security/trust-and-human-control",
      ].sort()
    );
  });

  it("does not link to missing internal documentation routes", () => {
    const brokenLinks = contentFiles.flatMap((path) => {
      const content = readFileSync(path, "utf8");
      const links = [...content.matchAll(/(?:href=["']|\]\()(\/[^#?'"\s)]+)/g)].map(
        (match) => match[1]
      );

      return links
        .filter((link) => !publicRoutes.has(link))
        .map((link) => `${relative(contentRoot, path)} -> ${link}`);
    });

    expect(brokenLinks).toEqual([]);
  });

  it("keeps every relatedCode reference anchored to a tracked source path", () => {
    const repositoryRoot = resolve(contentRoot, "../../../..");
    const missingSources = contentFiles.flatMap((path) => {
      const content = readFileSync(path, "utf8");
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
      const relatedCode = frontmatter.match(/relatedCode:\n((?:\s+- .+\n?)*)/)?.[1] ?? "";

      return [...relatedCode.matchAll(/^\s+- (.+)$/gm)]
        .map((match) => match[1])
        .filter((sourcePath) => !existsSync(resolve(repositoryRoot, sourcePath)))
        .map((sourcePath) => `${relative(contentRoot, path)} -> ${sourcePath}`);
    });

    expect(missingSources).toEqual([]);
  });
});
