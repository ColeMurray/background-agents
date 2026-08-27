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

// This sandbox-shipped file cannot import the workspace package at runtime.
// Keep these envelopes symmetric with @open-inspect/shared/pull-request-tool.
export function formatPullRequestSuccess(result) {
  const state = result?.state === "draft" ? "draft" : "open";
  const branches =
    result?.headBranch && result?.baseBranch
      ? ` (${result.headBranch} -> ${result.baseBranch})`
      : "";
  let agentMessage;
  if (result?.updated) {
    agentMessage = `Pull request updated with your latest commits.\n\nPR #${result.prNumber}${branches}: ${result.prUrl}`;
  } else {
    const status =
      state === "draft"
        ? "The pull request is in draft mode."
        : "The pull request is now ready for review.";
    agentMessage = `Pull request created successfully!\n\nPR #${result.prNumber}${branches}: ${result.prUrl}\n\n${status}`;
  }

  return JSON.stringify({
    kind: result.updated ? "updated" : "created",
    prNumber: result.prNumber,
    prUrl: result.prUrl,
    state,
    headBranch: result.headBranch,
    baseBranch: result.baseBranch,
    agentMessage,
  });
}

export function formatPullRequestFailure(message) {
  return JSON.stringify({ kind: "failure", message, agentMessage: message });
}

export function formatManualPullRequest(createPrUrl) {
  const agentMessage = `Branch pushed successfully.\n\nCreate the pull request in GitHub:\n${createPrUrl}\n\nUse your logged-in GitHub account to finish creating the PR.`;
  return JSON.stringify({ kind: "manual", createPrUrl, agentMessage });
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
    "Create a pull request for the committed changes. DO NOT use 'gh' CLI - use this tool instead. It handles git push and PR creation automatically with pre-configured authentication. You MUST provide a descriptive title and body that explain what changes were made. Call this after committing your changes. Calling it again from the same branch updates that branch's open pull request with your latest commits. To open a separate, additional pull request (including stacked PRs), create a new branch with 'git checkout -b', commit, and call this tool again.",
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
      .describe(
        "Target branch to merge into. Defaults to the session's base branch. For a stacked " +
          "pull request, pass the head branch of the pull request you are stacking on."
      ),
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
        "Whether to open the pull request as a draft. Set to true only when the user explicitly asks for a draft; otherwise omit this field so the pull request is ready for review. Note: repository policy may still require draft mode."
      ),
  },
  async execute(args, _context) {
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
        return formatPullRequestFailure(
          `Failed to create pull request: ${args.repo} is not part of this session. Valid values: ${validValues}.`
        );
      }
      if (!target) {
        return formatPullRequestFailure(
          'Failed to create pull request: repo must be "owner/name".'
        );
      }
      // Use the manifest's canonical casing and path — checkout directories
      // and the control plane's member records are case-sensitive.
      repoOwner = target.owner;
      repoName = target.name;
      repoPath = target.path;
    } else if (repositories.length > 1) {
      return formatPullRequestFailure(
        `Failed to create pull request: this session spans multiple repositories — pass repo with one of: ${validValues}.`
      );
    }

    const headBranch = await getCurrentBranch(repoPath);

    try {
      const sessionId = getSessionId();
      console.log(`[create-pull-request] Session ID: ${sessionId || "<empty>"}`);
      console.log(`[create-pull-request] Bridge URL: ${BRIDGE_URL}`);
      console.log(`[create-pull-request] Bridge Token: ${BRIDGE_TOKEN ? "<set>" : "<not set>"}`);

      if (!sessionId) {
        console.log("[create-pull-request] ERROR: Session ID not found");
        return formatPullRequestFailure(
          "Failed to create pull request: Session ID not found in environment. Please check that SESSION_CONFIG is set correctly."
        );
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
          userMessage = `Conflict: ${errorMessage} To open an additional pull request, create a new branch ('git checkout -b'), commit, and call this tool again.`;
        }

        console.log(`[create-pull-request] ERROR: HTTP ${response.status} - ${errorMessage}`);
        return formatPullRequestFailure(userMessage);
      }

      const result = await response.json();

      if (result?.status === "manual" && result?.createPrUrl) {
        console.log("[create-pull-request] SUCCESS: branch pushed, manual PR URL generated");
        return formatManualPullRequest(result.createPrUrl);
      }

      console.log(`[create-pull-request] SUCCESS: PR #${result.prNumber} created`);
      return formatPullRequestSuccess(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[create-pull-request] ERROR: ${message}`);
      return formatPullRequestFailure(`Failed to create pull request: ${message}`);
    }
  },
});
