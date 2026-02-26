/**
 * Local background agents server.
 *
 * Fastify server with WebSocket support that replaces the Cloudflare Workers
 * control plane. Runs entirely on localhost.
 */

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { getDb, closeDb } from "./db.js";
import { Repository } from "./repository.js";
import { DockerManager } from "./docker.js";
import { WorktreeManager } from "./worktree.js";
import {
  initSessionManager,
  handleClientSubscribe,
  handleClientPrompt,
  handleStopExecution,
  handleSandboxEvent,
  registerSandboxWs,
  unregisterSandboxWs,
  unregisterClientWs,
  archiveSession,
  unarchiveSession,
  handleFetchHistory,
  cleanupSession,
  discoverLocalRepos,
} from "./session-manager.js";
import {
  isValidModel,
  getValidModelOrDefault,
  DEFAULT_ENABLED_MODELS,
  type SandboxEvent,
  type ValidModel,
} from "@background-agents/shared";
import { nanoid } from "nanoid";
import path from "node:path";

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";

// ─── Initialize ─────────────────────────────────────────────────────────────

const db = getDb();
const repo = new Repository(db);
const dockerManager = new DockerManager();
const worktreeManager = new WorktreeManager();

initSessionManager(repo, dockerManager, worktreeManager);

// ─── Fastify setup ──────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

await app.register(cors, {
  origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

await app.register(websocket);

// ─── Health check ───────────────────────────────────────────────────────────

app.get("/health", async () => {
  const dockerHealth = await dockerManager.healthCheck();
  return {
    status: "ok",
    docker: dockerHealth,
    timestamp: Date.now(),
  };
});

// ─── Sessions REST API ──────────────────────────────────────────────────────

app.get("/sessions", async (request) => {
  const query = request.query as { status?: string; limit?: string; cursor?: string };
  const { sessions, hasMore } = repo.listSessions({
    status: query.status,
    limit: query.limit ? parseInt(query.limit) : undefined,
    cursor: query.cursor,
  });

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      repoOwner: s.repo_name,
      repoName: s.repo_name,
      repoPath: s.repo_path,
      branchName: s.branch_name,
      status: s.status,
      sandboxStatus: s.sandbox_status,
      model: s.model,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    })),
    hasMore,
  };
});

app.post("/sessions", async (request) => {
  const body = request.body as {
    repoPath: string;
    title?: string;
    model?: string;
    reasoningEffort?: string;
  };

  if (!body.repoPath) {
    return { error: "repoPath is required" };
  }

  const repoName = path.basename(body.repoPath);
  const model = getValidModelOrDefault(body.model);

  // Detect base branch
  let baseBranch = "main";
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: body.repoPath,
    });
    baseBranch = stdout.trim();
  } catch {
    // Fall back to "main"
  }

  const sessionId = nanoid(12);
  const session = repo.createSession({
    id: sessionId,
    title: body.title || null,
    repoPath: body.repoPath,
    repoName,
    baseBranch,
    model,
    reasoningEffort: body.reasoningEffort,
  });

  return {
    sessionId: session.id,
    status: session.status,
  };
});

app.get("/sessions/:id", async (request) => {
  const { id } = request.params as { id: string };
  const session = repo.getSession(id);
  if (!session) {
    return { error: "Session not found" };
  }

  return {
    id: session.id,
    title: session.title,
    repoOwner: session.repo_name,
    repoName: session.repo_name,
    repoPath: session.repo_path,
    branchName: session.branch_name,
    baseBranch: session.base_branch,
    status: session.status,
    sandboxStatus: session.sandbox_status,
    model: session.model,
    reasoningEffort: session.reasoning_effort,
    messageCount: repo.getMessageCount(id),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
});

app.delete("/sessions/:id", async (request) => {
  const { id } = request.params as { id: string };
  const session = repo.getSession(id);
  if (!session) {
    return { error: "Session not found" };
  }

  // Stop and remove container
  if (session.container_id) {
    await dockerManager.removeSandbox(session.container_id);
  }

  // Remove worktree
  if (session.worktree_path) {
    await worktreeManager.remove(id, session.repo_path);
  }

  // Cleanup in-memory state
  await cleanupSession(id);

  // Delete from DB
  repo.deleteSession(id);

  return { ok: true };
});

app.post("/sessions/:id/prompt", async (request) => {
  const { id } = request.params as { id: string };
  const body = request.body as {
    content: string;
    model?: string;
    reasoningEffort?: string;
  };

  await handleClientPrompt(id, body);
  return { ok: true };
});

app.post("/sessions/:id/stop", async (request) => {
  const { id } = request.params as { id: string };
  handleStopExecution(id);
  return { ok: true };
});

app.get("/sessions/:id/events", async (request) => {
  const { id } = request.params as { id: string };
  const query = request.query as {
    type?: string;
    messageId?: string;
    limit?: string;
    cursor?: string;
  };

  const { events, hasMore } = repo.listEvents(id, {
    type: query.type,
    messageId: query.messageId,
    limit: query.limit ? parseInt(query.limit) : undefined,
    cursor: query.cursor,
  });

  return {
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      data: JSON.parse(e.data),
      messageId: e.message_id,
      createdAt: e.created_at,
    })),
    hasMore,
  };
});

app.get("/sessions/:id/artifacts", async (request) => {
  const { id } = request.params as { id: string };
  const artifacts = repo.listArtifacts(id);
  return {
    artifacts: artifacts.map((a) => ({
      id: a.id,
      type: a.type,
      url: a.url,
      metadata: a.metadata ? JSON.parse(a.metadata) : null,
      createdAt: a.created_at,
    })),
  };
});

app.post("/sessions/:id/archive", async (request) => {
  const { id } = request.params as { id: string };
  await archiveSession(id);
  return { ok: true };
});

app.post("/sessions/:id/unarchive", async (request) => {
  const { id } = request.params as { id: string };
  unarchiveSession(id);
  return { ok: true };
});

// ─── Repos ──────────────────────────────────────────────────────────────────

app.get("/repos", async (request) => {
  const query = request.query as { dirs?: string };
  const searchDirs = query.dirs?.split(",") || undefined;
  const repos = await discoverLocalRepos(searchDirs);
  return { repos };
});

// ─── Settings ───────────────────────────────────────────────────────────────

app.get("/settings", async () => {
  const modelPrefs = repo.getSetting("model_preferences");
  const enabledModels: ValidModel[] = modelPrefs ? JSON.parse(modelPrefs) : DEFAULT_ENABLED_MODELS;

  return {
    enabledModels,
  };
});

app.put("/settings", async (request) => {
  const body = request.body as { enabledModels?: string[] };

  if (body.enabledModels) {
    const valid = body.enabledModels.filter((m) => isValidModel(m));
    repo.setSetting("model_preferences", JSON.stringify(valid));
  }

  return { ok: true };
});

// ─── Secrets REST API ───────────────────────────────────────────────────────

// Global secrets
app.get("/secrets", async () => {
  const secrets = repo.listSecrets("global");
  return { secrets: secrets.map((s) => ({ key: s.key })), globalSecrets: [] };
});

app.put("/secrets", async (request) => {
  const body = request.body as { secrets: Record<string, string> };
  if (!body.secrets || typeof body.secrets !== "object") {
    return { error: "secrets object is required" };
  }
  repo.upsertSecrets("global", body.secrets);
  return { ok: true };
});

app.delete("/secrets/:key", async (request) => {
  const { key } = request.params as { key: string };
  const deleted = repo.deleteSecret("global", key);
  return { ok: deleted };
});

// Repo-scoped secrets
app.get("/repos/:owner/:name/secrets", async (request) => {
  const { owner, name } = request.params as { owner: string; name: string };
  const scope = `${owner}/${name}`;
  const secrets = repo.listSecrets(scope);
  const globalSecrets = repo.listSecrets("global");
  return {
    secrets: secrets.map((s) => ({ key: s.key })),
    globalSecrets,
  };
});

app.put("/repos/:owner/:name/secrets", async (request) => {
  const { owner, name } = request.params as { owner: string; name: string };
  const body = request.body as { secrets: Record<string, string> };
  if (!body.secrets || typeof body.secrets !== "object") {
    return { error: "secrets object is required" };
  }
  repo.upsertSecrets(`${owner}/${name}`, body.secrets);
  return { ok: true };
});

app.delete("/repos/:owner/:name/secrets/:key", async (request) => {
  const { owner, name, key } = request.params as { owner: string; name: string; key: string };
  const deleted = repo.deleteSecret(`${owner}/${name}`, key);
  return { ok: deleted };
});

// ─── WebSocket endpoint ─────────────────────────────────────────────────────

app.register(async function wsRoutes(fastify) {
  fastify.get("/sessions/:id/ws", { websocket: true }, (socket, request) => {
    const { id: sessionId } = request.params as { id: string };
    const query = request.query as { type?: string };
    const isSandbox = query.type === "sandbox";

    if (isSandbox) {
      // Sandbox bridge connection
      registerSandboxWs(sessionId, socket);
      console.log(`[ws] Sandbox connected for session ${sessionId}`);

      socket.on("message", async (raw) => {
        try {
          const event = JSON.parse(raw.toString()) as SandboxEvent;
          await handleSandboxEvent(sessionId, event);
        } catch (error) {
          console.error(`[ws] Error handling sandbox event:`, error);
        }
      });

      socket.on("close", () => {
        console.log(`[ws] Sandbox disconnected for session ${sessionId}`);
        unregisterSandboxWs(sessionId, socket);
      });

      socket.on("error", (error) => {
        console.error(`[ws] Sandbox WS error for session ${sessionId}:`, error);
        unregisterSandboxWs(sessionId, socket);
      });
    } else {
      // Client connection
      console.log(`[ws] Client connected for session ${sessionId}`);

      socket.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case "ping":
              socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
              break;

            case "subscribe":
              handleClientSubscribe(sessionId, socket);
              break;

            case "prompt":
              await handleClientPrompt(sessionId, {
                content: msg.content,
                model: msg.model,
                reasoningEffort: msg.reasoningEffort,
              });
              break;

            case "stop":
              handleStopExecution(sessionId);
              break;

            case "fetch_history":
              if (msg.cursor) {
                handleFetchHistory(sessionId, socket, msg.cursor, msg.limit);
              }
              break;

            // Ignore typing/presence — single user
            case "typing":
            case "presence":
              break;

            default:
              console.warn(`[ws] Unknown client message type: ${msg.type}`);
          }
        } catch (error) {
          console.error(`[ws] Error handling client message:`, error);
        }
      });

      socket.on("close", () => {
        console.log(`[ws] Client disconnected for session ${sessionId}`);
        unregisterClientWs(sessionId, socket);
      });

      socket.on("error", (error) => {
        console.error(`[ws] Client WS error for session ${sessionId}:`, error);
        unregisterClientWs(sessionId, socket);
      });
    }
  });
});

// ─── Start server ───────────────────────────────────────────────────────────

async function start() {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`
  Background Agents Server running at http://localhost:${PORT}
  WebSocket endpoint: ws://localhost:${PORT}/sessions/:id/ws

  Health: http://localhost:${PORT}/health
  `);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  closeDb();
  await app.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  closeDb();
  await app.close();
  process.exit(0);
});

start();
