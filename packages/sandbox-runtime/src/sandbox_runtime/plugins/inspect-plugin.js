/**
 * Create Pull Request Tool for Open-Inspect.
 *
 * This tool creates a pull request for committed changes.
 * Uses tool() helper from @opencode-ai/plugin with tool.schema for Zod compatibility.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Debug: Log that the tool was loaded
console.log("[create-pull-request] Tool module loaded");
console.log(
  "[create-pull-request] CONTROL_PLANE_URL:",
  process.env.CONTROL_PLANE_URL || "<not set>"
);
console.log(
  "[create-pull-request] SANDBOX_AUTH_TOKEN:",
  process.env.SANDBOX_AUTH_TOKEN ? "<set>" : "<not set>"
);
console.log(
  "[create-pull-request] SESSION_CONFIG:",
  process.env.SESSION_CONFIG ? "<set>" : "<not set>"
);

// Get bridge configuration from environment
const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787";
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN || "";

// Get session ID from SESSION_CONFIG
function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    console.log(
      "[create-pull-request] Parsed SESSION_CONFIG, sessionId:",
      config.sessionId || config.session_id || "<not found>"
    );
    return config.sessionId || config.session_id || "";
  } catch (e) {
    console.log("[create-pull-request] Failed to parse SESSION_CONFIG:", e.message);
    return "";
  }
}

// Canonical repository manifest written by the supervisor — the single owner
// of the /workspace checkout layout. Mirrors REPO_MANIFEST_FILE_PATH in
// sandbox_runtime/constants.py.
const REPO_MANIFEST_PATH = "/tmp/oi-repo-manifest.json";

// Ordered repository list {owner, name, path} from the supervisor's manifest
// (empty when the manifest is absent, e.g. tool run outside a sandbox boot).
function getRepositories() {
  try {
    const manifest = JSON.parse(readFileSync(REPO_MANIFEST_PATH, "utf8"));
    const repositories = Array.isArray(manifest?.repositories) ? manifest.repositories : [];
    return repositories
      .map((entry) => ({
        owner: String(entry?.owner || "").trim(),
        name: String(entry?.name || "").trim(),
        path: String(entry?.path || "").trim(),
      }))
      .filter((entry) => entry.owner && entry.name && entry.path);
  } catch (e) {
    console.log("[create-pull-request] Failed to read repo manifest:", e.message);
    return [];
  }
}

/** Resolve an owner/name argument, preserving nested owners and manifest casing. */
export function resolveRepositoryTarget(repo, repositories) {
  const requested = String(repo || "").trim();

  if (repositories.length > 0) {
    const normalized = requested.toLowerCase();
    return (
      repositories.find(
        (repository) => `${repository.owner}/${repository.name}`.toLowerCase() === normalized
      ) || null
    );
  }

  const separator = requested.lastIndexOf("/");
  if (separator <= 0 || separator === requested.length - 1) {
    return null;
  }

  const owner = requested.slice(0, separator);
  const name = requested.slice(separator + 1);
  return owner.split("/").some((segment) => !segment) ? null : { owner, name };
}

async function getCurrentBranch(repoPath) {
  try {
    const gitArgs = repoPath
      ? ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]
      : ["rev-parse", "--abbrev-ref", "HEAD"];
    const { stdout } = await execFileAsync("git", gitArgs, {
      timeout: 5000,
    });
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      return undefined;
    }
    return branch;
  } catch (e) {
    console.log("[create-pull-request] Failed to resolve current branch:", e.message);
    return undefined;
  }
}

// Use tool() helper - args should be a ZodRawShape (plain object), NOT a ZodObject
// OpenCode wraps it with z.object() internally
export default tool({
  name: "create-pull-request",
  description:
    "Create a pull request for the committed changes. DO NOT use 'gh' CLI - use this tool instead. It handles git push and PR creation automatically with pre-configured authentication. You MUST provide a descriptive title and body that explain what changes were made. Call this after committing your changes.",
  args: {
    title: z
      .string()
      .describe(
        "Title of the pull request. Should be concise and descriptive of the changes made."
      ),
    body: z
      .string()
      .describe(
        "Body/description of the pull request. Explain what changes were made and why. Use markdown formatting for clarity."
      ),
    baseBranch: z
      .string()
      .optional()
      .describe("Target branch to merge into. Defaults to the session's base branch."),
    repo: z
      .string()
      .optional()
      .describe(
        'Target repository as "owner/name". Required when the session spans multiple ' +
          "repositories; may be omitted for single-repository sessions."
      ),
    draft: z
      .boolean()
      .optional()
      .describe(
        "Open the pull request as a draft. Set to true to open a draft PR, or false for a ready-for-review PR. Note: this may be overridden by policy."
      ),
  },
  async execute(args, context) {
    console.log(`[create-pull-request] execute() called with args:`, JSON.stringify(args));
    const title = args.title || "Changes from OpenCode session";
    const body = args.body || "Automated PR created via create-pull-request tool";
    const baseBranch = args.baseBranch; // undefined if not provided, server will use default
    const draft = args.draft; // undefined if not provided, server falls back to repo setting

    // Resolve the target repository for multi-repo sessions.
    const repositories = getRepositories();
    const validValues = repositories.map((r) => `${r.owner}/${r.name}`).join(", ");
    let repoOwner;
    let repoName;
    let repoPath;
    if (args.repo) {
      const target = resolveRepositoryTarget(args.repo, repositories);
      if (!target && repositories.length > 0) {
        return `Failed to create pull request: ${args.repo} is not part of this session. Valid values: ${validValues}.`;
      }
      if (!target) {
        return 'Failed to create pull request: repo must be "owner/name".';
      }
      // Use the manifest's canonical casing and path — checkout directories
      // and the control plane's member records are case-sensitive.
      repoOwner = target.owner;
      repoName = target.name;
      repoPath = target.path;
    } else if (repositories.length > 1) {
      return `Failed to create pull request: this session spans multiple repositories — pass repo with one of: ${validValues}.`;
    }

    const headBranch = await getCurrentBranch(repoPath);

    try {
      const sessionId = getSessionId();
      console.log(`[create-pull-request] Session ID: ${sessionId || "<empty>"}`);
      console.log(`[create-pull-request] Bridge URL: ${BRIDGE_URL}`);
      console.log(`[create-pull-request] Bridge Token: ${BRIDGE_TOKEN ? "<set>" : "<not set>"}`);

      if (!sessionId) {
        console.log("[create-pull-request] ERROR: Session ID not found");
        return "Failed to create pull request: Session ID not found in environment. Please check that SESSION_CONFIG is set correctly.";
      }

      // Use the session-specific endpoint
      const url = `${BRIDGE_URL}/sessions/${sessionId}/pr`;
      console.log(`[create-pull-request] Calling PR endpoint: ${url}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
        },
        body: JSON.stringify({
          title: title,
          body: body,
          baseBranch: baseBranch,
          headBranch: headBranch,
          repoOwner: repoOwner,
          repoName: repoName,
          draft: draft,
          timestamp: Date.now(),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Try to parse as JSON to get structured error message
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorText;
        } catch {
          // Use raw text if not JSON
        }

        // Provide helpful messages based on status code
        let userMessage = `Failed to create pull request: ${errorMessage}`;
        if (response.status === 401) {
          userMessage = `Authentication failed: ${errorMessage}. The GitHub token may have expired - please re-authenticate.`;
        } else if (response.status === 404) {
          userMessage = `Session not found: ${errorMessage}. The session may have been deleted or the ID is incorrect.`;
        } else if (response.status === 409) {
          userMessage = `Conflict: ${errorMessage}. A PR may already exist for this branch.`;
        }

        console.log(`[create-pull-request] ERROR: HTTP ${response.status} - ${errorMessage}`);
        return userMessage;
      }

      const result = await response.json();

      if (result?.status === "manual" && result?.createPrUrl) {
        console.log("[create-pull-request] SUCCESS: branch pushed, manual PR URL generated");
        return `Branch pushed successfully.\n\nCreate the pull request in GitHub:\n${result.createPrUrl}\n\nUse your logged-in GitHub account to finish creating the PR.`;
      }

      console.log(`[create-pull-request] SUCCESS: PR #${result.prNumber} created`);
      return `Pull request created successfully!\n\nPR #${result.prNumber}: ${result.prUrl}\n\nThe PR is now ready for review.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[create-pull-request] ERROR: ${message}`);
      return `Failed to create pull request: ${message}`;
    }
  },
});
