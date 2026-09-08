import { Hono } from "hono";
import { getAvailableRepos } from "../classifier/repos";
import type { Env } from "../types";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/health", async (c) => {
  let repoCount = 0;
  try {
    repoCount = (await getAvailableRepos(c.env)).length;
  } catch {
    // Control plane may be unavailable.
  }
  return c.json({ status: "healthy", service: "open-inspect-slack-bot", repoCount });
});
