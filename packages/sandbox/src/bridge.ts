#!/usr/bin/env bun
/**
 * Agent bridge - bidirectional communication between sandbox and control plane.
 *
 * This module handles:
 * - WebSocket connection to control plane Durable Object
 * - Heartbeat loop for connection health
 * - Event forwarding from OpenCode to control plane
 * - Command handling from control plane (prompt, stop, snapshot)
 * - Git identity configuration per prompt author
 *
 * Port of packages/modal-infra/src/sandbox/bridge.py
 *
 * Note: Uses Bun's native WebSocket (global WebSocket class) instead of 'ws' package.
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
// Bun has native WebSocket support - no import needed, it's a global
import { messageId as generateMessageId } from "./opencode-id.js";
import type {
  AuthorInfo,
  BridgeEvent,
  GitUser,
  OpenCodeMessage,
  OpenCodePart,
  SessionCommand,
  SSEEvent,
} from "./types.js";

// Configuration
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
const RECONNECT_BACKOFF_BASE = 2;
const RECONNECT_MAX_DELAY = 60_000; // 60 seconds

interface BridgeConfig {
  sandboxId: string;
  sessionId: string;
  controlPlaneUrl: string;
  authToken: string;
  opencodePort: number;
}

class AgentBridge {
  private readonly config: BridgeConfig;
  private readonly opencodeBaseUrl: string;
  private ws: WebSocket | null = null;
  private shutdownRequested = false;
  private opencodeSessionId: string | null = null;
  private readonly sessionIdFile = "/tmp/opencode-session-id";
  private readonly repoPath = "/workspace";
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.opencodeBaseUrl = `http://localhost:${config.opencodePort}`;
  }

  /**
   * Get WebSocket URL for control plane connection.
   */
  private get wsUrl(): string {
    const url = this.config.controlPlaneUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");
    return `${url}/sessions/${this.config.sessionId}/ws?type=sandbox`;
  }

  /**
   * Main bridge loop with reconnection handling.
   */
  async run(): Promise<void> {
    console.log(`[bridge] Starting bridge for sandbox ${this.config.sandboxId}`);

    await this.loadSessionId();

    let reconnectAttempts = 0;

    while (!this.shutdownRequested) {
      try {
        await this.connectAndRun();
        reconnectAttempts = 0;
      } catch (error) {
        console.log(`[bridge] Connection error: ${error}`);
      }

      if (this.shutdownRequested) {
        break;
      }

      reconnectAttempts++;
      const delay = Math.min(
        Math.pow(RECONNECT_BACKOFF_BASE, reconnectAttempts) * 1000,
        RECONNECT_MAX_DELAY
      );
      console.log(`[bridge] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
      await this.sleep(delay);
    }
  }

  /**
   * Connect to control plane and handle messages.
   * Uses browser-style WebSocket API (compatible with Bun's native WebSocket).
   */
  private async connectAndRun(): Promise<void> {
    console.log(`[bridge] Connecting to ${this.wsUrl}`);

    return new Promise((resolve, reject) => {
      // Bun's WebSocket doesn't support headers in constructor
      // We'll need to pass auth via query params or the server needs to accept without headers
      const urlWithAuth = `${this.wsUrl}&token=${encodeURIComponent(this.config.authToken)}&sandboxId=${encodeURIComponent(this.config.sandboxId)}`;
      this.ws = new WebSocket(urlWithAuth);

      this.ws.onopen = async () => {
        console.log("[bridge] Connected to control plane");

        await this.sendEvent({
          type: "ready",
          sandboxId: this.config.sandboxId,
          opencodeSessionId: this.opencodeSessionId ?? undefined,
        });

        this.startHeartbeat();
      };

      this.ws.onmessage = async (event) => {
        if (this.shutdownRequested) {
          return;
        }

        try {
          const data = typeof event.data === "string" ? event.data : event.data.toString();
          const cmd = JSON.parse(data) as SessionCommand;
          await this.handleCommand(cmd);
        } catch (error) {
          console.log(`[bridge] Error handling command: ${error}`);
        }
      };

      this.ws.onclose = (event) => {
        console.log(`[bridge] Connection closed: ${event.code} - ${event.reason}`);
        this.stopHeartbeat();
        this.ws = null;
        resolve();
      };

      this.ws.onerror = (event) => {
        console.log(`[bridge] WebSocket error: ${event}`);
        this.stopHeartbeat();
        this.ws = null;
        reject(new Error("WebSocket error"));
      };
    });
  }

  /**
   * Start heartbeat loop.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      // WebSocket.OPEN === 1 in browser API
      if (this.ws?.readyState === 1) {
        await this.sendEvent({
          type: "heartbeat",
          sandboxId: this.config.sandboxId,
          status: "ready",
          timestamp: Date.now() / 1000,
        });
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat loop.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send event to control plane.
   */
  private async sendEvent(event: BridgeEvent): Promise<void> {
    // WebSocket.OPEN === 1 in browser API
    if (!this.ws || this.ws.readyState !== 1) {
      console.log(`[bridge] Cannot send ${event.type}: WebSocket not open`);
      return;
    }

    const fullEvent = {
      ...event,
      sandboxId: this.config.sandboxId,
      timestamp: (event as { timestamp?: number }).timestamp ?? Date.now() / 1000,
    };

    try {
      this.ws.send(JSON.stringify(fullEvent));
      console.log(`[bridge] Sent event: ${event.type}`);
    } catch (error) {
      console.log(`[bridge] Failed to send ${event.type} event: ${error}`);
    }
  }

  /**
   * Handle command from control plane.
   */
  private async handleCommand(cmd: SessionCommand): Promise<void> {
    console.log(`[bridge] Received command: ${cmd.type}`);

    switch (cmd.type) {
      case "prompt":
        // Run prompt handling in background to keep WebSocket responsive
        this.handlePrompt(cmd).catch((error) => {
          console.log(`[bridge] Prompt error: ${error}`);
          this.sendEvent({
            type: "execution_complete",
            messageId: cmd.messageId,
            success: false,
            error: String(error),
          });
        });
        break;

      case "stop":
        await this.handleStop();
        break;

      case "push":
        await this.handlePush(cmd);
        break;

      case "snapshot":
        await this.handleSnapshot();
        break;

      case "shutdown":
        await this.handleShutdown();
        break;

      default:
        console.log(`[bridge] Unknown command type: ${(cmd as { type: string }).type}`);
    }
  }

  /**
   * Handle prompt command - send to OpenCode and stream response.
   */
  private async handlePrompt(cmd: {
    messageId: string;
    content: string;
    model?: string;
    author?: AuthorInfo;
  }): Promise<void> {
    const { messageId, content, model, author } = cmd;

    console.log(
      `[bridge] Processing prompt ${messageId} with model ${model}, author=${JSON.stringify(author)}`
    );

    // Configure git identity if author provided
    if (author?.githubName && author?.githubEmail) {
      await this.configureGitIdentity({
        name: author.githubName,
        email: author.githubEmail,
      });
    }

    // Create OpenCode session if needed
    if (!this.opencodeSessionId) {
      await this.createOpenCodeSession();
    }

    try {
      for await (const event of this.streamOpenCodeResponse(messageId, content, model)) {
        await this.sendEvent(event);
      }

      await this.sendEvent({
        type: "execution_complete",
        messageId,
        success: true,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : "";
      console.log(`[bridge] Error processing prompt: ${errorMsg}`);
      console.log(`[bridge] Error stack: ${errorStack}`);
      await this.sendEvent({
        type: "execution_complete",
        messageId,
        success: false,
        error: `${errorMsg}\nStack: ${errorStack}`,
      });
    }
  }

  /**
   * Create a new OpenCode session.
   */
  private async createOpenCodeSession(): Promise<void> {
    console.log("[bridge] Creating OpenCode session...");

    try {
      // OpenCode session creation can take a while as it bootstraps plugins
      // Give it up to 2 minutes
      const response = await fetch(`${this.opencodeBaseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(120_000),
      });

      console.log(`[bridge] Session creation response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create session: ${response.status} - ${errorText}`);
      }

      let responseText: string;
      try {
        responseText = await response.text();
      } catch (textError) {
        console.log(`[bridge] Error reading response text: ${textError}`);
        throw textError;
      }
      console.log(`[bridge] Session response: ${responseText.slice(0, 500)}`);

      let data: { id: string };
      try {
        data = JSON.parse(responseText) as { id: string };
      } catch (parseError) {
        console.log(`[bridge] JSON parse error: ${parseError}`);
        throw parseError;
      }
      this.opencodeSessionId = data.id;
      console.log(`[bridge] Created OpenCode session: ${this.opencodeSessionId}`);

      await this.saveSessionId();
    } catch (error) {
      console.log(`[bridge] Session creation error: ${error}`);
      throw error;
    }
  }

  /**
   * Build request body for OpenCode prompt requests.
   */
  private buildPromptRequestBody(
    content: string,
    model: string | undefined,
    opencodeMessageId: string
  ): Record<string, unknown> {
    const requestBody: Record<string, unknown> = {
      parts: [{ type: "text", text: content }],
      messageID: opencodeMessageId,
    };

    console.log(`[bridge] Building prompt request, messageID=${opencodeMessageId}`);

    if (model) {
      let providerId: string;
      let modelId: string;

      if (model.includes("/")) {
        [providerId, modelId] = model.split("/", 2);
      } else {
        providerId = "anthropic";
        modelId = model;
      }

      requestBody.model = {
        providerID: providerId,
        modelID: modelId,
      };
    }

    return requestBody;
  }

  /**
   * Stream response from OpenCode using Server-Sent Events.
   */
  private async *streamOpenCodeResponse(
    messageId: string,
    content: string,
    model?: string
  ): AsyncGenerator<BridgeEvent> {
    if (!this.opencodeSessionId) {
      throw new Error("OpenCode session not initialized");
    }

    const opencodeMessageId = generateMessageId();
    const requestBody = this.buildPromptRequestBody(content, model, opencodeMessageId);

    const sseUrl = `${this.opencodeBaseUrl}/event`;
    const asyncUrl = `${this.opencodeBaseUrl}/session/${this.opencodeSessionId}/prompt_async`;

    console.log(`[bridge] Connecting to SSE endpoint: ${sseUrl}, messageID=${opencodeMessageId}`);

    const cumulativeText = new Map<string, string>();
    const emittedToolStates = new Set<string>();
    const ourAssistantMsgIds = new Set<string>();

    const maxWaitTime = 300_000; // 5 minutes
    const startTime = Date.now();

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), maxWaitTime);

    try {
      // Connect to SSE endpoint
      const sseResponse = await fetch(sseUrl, {
        signal: controller.signal,
      });

      if (!sseResponse.ok) {
        throw new Error(`SSE connection failed: ${sseResponse.status}`);
      }

      console.log("[bridge] SSE connected, sending prompt...");

      // Send prompt asynchronously
      const promptResponse = await fetch(asyncUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30_000),
      });

      if (!promptResponse.ok && promptResponse.status !== 204) {
        const errorBody = await promptResponse.text();
        console.log(`[bridge] Prompt request body: ${JSON.stringify(requestBody)}`);
        console.log(`[bridge] Prompt error response: ${errorBody}`);
        throw new Error(`Async prompt failed: ${promptResponse.status} - ${errorBody}`);
      }

      console.log("[bridge] Prompt sent, processing SSE events...");

      // Process SSE stream using text() and manual parsing
      // This avoids issues with Bun's stream reader
      if (!sseResponse.body) {
        throw new Error("No response body");
      }

      let buffer = "";

      // Use Bun-compatible streaming with async iterator
      const reader = sseResponse.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            console.log("[bridge] SSE stream ended");
            break;
          }

          // Decode chunk - handle potential errors
          let chunk: string;
          try {
            chunk = decoder.decode(value, { stream: true });
          } catch (e) {
            console.log(`[bridge] Decode error, skipping chunk: ${e}`);
            continue;
          }

          buffer += chunk;

          // Process complete events (delimited by double newline)
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const eventStr = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            // Parse data lines
            const dataLines: string[] = [];
            for (const line of eventStr.split("\n")) {
              if (line.startsWith("data:")) {
                const dataContent = line.slice(5).trim();
                if (dataContent) {
                  dataLines.push(dataContent);
                }
              }
            }

            if (dataLines.length === 0) continue;

            try {
              const event = JSON.parse(dataLines.join("\n")) as SSEEvent;
              const events = this.processSSEEvent(
                event,
                messageId,
                opencodeMessageId,
                cumulativeText,
                emittedToolStates,
                ourAssistantMsgIds,
                startTime
              );

              for (const bridgeEvent of events) {
                if (bridgeEvent === "done") {
                  // Fetch final state and return
                  for await (const finalEvent of this.fetchFinalMessageState(
                    messageId,
                    opencodeMessageId,
                    cumulativeText,
                    ourAssistantMsgIds
                  )) {
                    yield finalEvent;
                  }
                  return;
                }
                yield bridgeEvent;
              }
            } catch (error) {
              console.log(
                `[bridge] SSE JSON parse error: ${error}, data: ${dataLines.join("").slice(0, 100)}`
              );
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Process a single SSE event.
   */
  private processSSEEvent(
    event: SSEEvent,
    messageId: string,
    opencodeMessageId: string,
    cumulativeText: Map<string, string>,
    emittedToolStates: Set<string>,
    ourAssistantMsgIds: Set<string>,
    startTime: number
  ): (BridgeEvent | "done")[] {
    const results: (BridgeEvent | "done")[] = [];
    const props = event.properties;

    if (event.type === "server.connected" || event.type === "server.heartbeat") {
      return results;
    }

    // Check session ID match
    const eventSessionId =
      (props.sessionID as string) || (props.part as { sessionID?: string })?.sessionID;
    if (eventSessionId && eventSessionId !== this.opencodeSessionId) {
      return results;
    }

    if (event.type === "message.updated") {
      const info = props.info as {
        sessionID?: string;
        id?: string;
        parentID?: string;
        role?: string;
        finish?: string;
      };

      if (info?.sessionID === this.opencodeSessionId) {
        const ocMsgId = info.id || "";
        const parentId = info.parentID || "";
        const role = info.role || "";
        const finish = info.finish || "";

        console.log(
          `[bridge] message.updated: role=${role}, id=${ocMsgId}, parentID=${parentId}, expected=${opencodeMessageId}, match=${parentId === opencodeMessageId}`
        );

        if (role === "assistant" && parentId === opencodeMessageId && ocMsgId) {
          ourAssistantMsgIds.add(ocMsgId);
          console.log(`[bridge] Tracking assistant message ${ocMsgId} (parentID matched)`);
        }

        if (finish && finish !== "tool-calls" && finish !== "") {
          console.log(`[bridge] SSE message finished (finish=${finish})`);
        }
      }
    } else if (event.type === "message.part.updated") {
      const part = props.part as OpenCodePart;
      const delta = props.delta as string | undefined;
      const partType = part?.type || "";
      const partId = (part as { id?: string })?.id || "";
      const ocMsgId = (part as { messageID?: string })?.messageID || "";

      // Filter to our assistant messages
      if (ourAssistantMsgIds.size > 0 && !ourAssistantMsgIds.has(ocMsgId)) {
        return results;
      }

      if (partType === "text") {
        const textPart = part as { text?: string };
        const text = textPart.text || "";

        if (delta) {
          cumulativeText.set(partId, (cumulativeText.get(partId) || "") + delta);
        } else {
          cumulativeText.set(partId, text);
        }

        const currentText = cumulativeText.get(partId);
        if (currentText) {
          results.push({
            type: "token",
            content: currentText,
            messageId,
          });
        }
      } else if (partType === "tool") {
        const toolPart = part as {
          tool?: string;
          callID?: string;
          state?: { status?: string; input?: Record<string, unknown>; output?: string };
        };

        const state = toolPart.state || {};
        const status = state.status || "";
        const toolInput = state.input || {};

        console.log(
          `[bridge] Tool part: tool=${toolPart.tool}, status=${status}, input_keys=${Object.keys(toolInput)}`
        );

        // Skip pending tools with no input
        if ((status === "pending" || status === "") && Object.keys(toolInput).length === 0) {
          console.log(`[bridge] Skipping tool_call in ${status} state with no input`);
          return results;
        }

        const callId = toolPart.callID || "";
        const toolKey = `tool:${callId}:${status}`;

        if (!emittedToolStates.has(toolKey)) {
          emittedToolStates.add(toolKey);
          results.push({
            type: "tool_call",
            tool: toolPart.tool || "",
            args: toolInput,
            callId,
            status,
            output: state.output,
            messageId,
          });
        }
      } else if (partType === "step-start") {
        results.push({ type: "step_start", messageId });
      } else if (partType === "step-finish") {
        const finishPart = part as {
          cost?: number;
          tokens?: { input: number; output: number };
          reason?: string;
        };
        results.push({
          type: "step_finish",
          messageId,
          cost: finishPart.cost,
          tokens: finishPart.tokens,
          reason: finishPart.reason,
        });
      }
    } else if (event.type === "session.idle" || event.type === "session.status") {
      const sessionId = props.sessionID as string;
      const status = props.status as { type?: string };

      if (
        sessionId === this.opencodeSessionId &&
        (event.type === "session.idle" || status?.type === "idle")
      ) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(
          `[bridge] SSE session idle received after ${elapsed.toFixed(1)}s, fetching final state...`
        );
        console.log(
          `[bridge] Tracked ${ourAssistantMsgIds.size} assistant messages: ${[...ourAssistantMsgIds]}`
        );
        results.push("done");
      }
    } else if (event.type === "session.error") {
      const sessionId = props.sessionID as string;
      if (sessionId === this.opencodeSessionId) {
        const error = props.error as { message?: string } | string;
        const errorMsg = typeof error === "string" ? error : error?.message || "Unknown error";
        console.log(`[bridge] SSE session.error: ${errorMsg}`);
        results.push({
          type: "error",
          error: errorMsg,
          messageId,
        });
        results.push("done");
      }
    }

    return results;
  }

  /**
   * Fetch final message state from API.
   */
  private async *fetchFinalMessageState(
    messageId: string,
    opencodeMessageId: string,
    cumulativeText: Map<string, string>,
    trackedMsgIds: Set<string>
  ): AsyncGenerator<BridgeEvent> {
    if (!this.opencodeSessionId) {
      return;
    }

    const messagesUrl = `${this.opencodeBaseUrl}/session/${this.opencodeSessionId}/message`;

    try {
      const response = await fetch(messagesUrl, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        console.log(`[bridge] Final state fetch failed: ${response.status}`);
        return;
      }

      const messages = (await response.json()) as OpenCodeMessage[];
      console.log(
        `[bridge] Final state fetch: got ${messages.length} messages, looking for parentID=${opencodeMessageId}`
      );

      for (const msg of messages) {
        const info = msg.info;
        const role = info?.role || "";
        const msgId = info?.id || "";
        const parentId = info?.parentID || "";

        if (role === "assistant") {
          console.log(
            `[bridge] Assistant message: id=${msgId}, parentID=${parentId}, match=${parentId === opencodeMessageId}`
          );
        }

        if (role !== "assistant") continue;

        const parentMatches = parentId === opencodeMessageId;
        const inTrackedSet = trackedMsgIds.has(msgId);

        if (!parentMatches && !inTrackedSet) {
          console.log(
            `[bridge] Skipping message ${msgId}: parentID=${parentId} != ${opencodeMessageId}, not in tracked set`
          );
          continue;
        }

        console.log(
          `[bridge] Processing message ${msgId}: parent_match=${parentMatches}, in_tracked=${inTrackedSet}`
        );

        for (const part of msg.parts || []) {
          if (part.type === "text") {
            const textPart = part as { id?: string; text?: string };
            const partId = textPart.id || "";
            const text = textPart.text || "";
            const previouslySent = cumulativeText.get(partId) || "";

            if (text.length > previouslySent.length) {
              console.log(
                `[bridge] Final fetch found additional text: ${previouslySent.length} -> ${text.length} chars`
              );
              cumulativeText.set(partId, text);
              yield {
                type: "token",
                content: text,
                messageId,
              };
            }
          }
        }
      }
    } catch (error) {
      console.log(`[bridge] Error fetching final state: ${error}`);
    }
  }

  /**
   * Handle stop command.
   */
  private async handleStop(): Promise<void> {
    console.log("[bridge] Stopping current execution");

    if (!this.opencodeSessionId) {
      return;
    }

    try {
      await fetch(`${this.opencodeBaseUrl}/session/${this.opencodeSessionId}/stop`, {
        method: "POST",
      });
    } catch (error) {
      console.log(`[bridge] Error stopping execution: ${error}`);
    }
  }

  /**
   * Handle push command.
   */
  private async handlePush(cmd: {
    branchName: string;
    repoOwner?: string;
    repoName?: string;
    githubToken?: string;
  }): Promise<void> {
    const { branchName, githubToken } = cmd;
    const repoOwner = cmd.repoOwner || process.env.REPO_OWNER || "";
    const repoName = cmd.repoName || process.env.REPO_NAME || "";

    const tokenSource = githubToken
      ? "fresh from command"
      : process.env.GITHUB_APP_TOKEN
        ? "from env"
        : "none";

    console.log(
      `[bridge] Pushing branch: ${branchName} to ${repoOwner}/${repoName} (token: ${tokenSource})`
    );

    // Find repo directory
    const repoDirs = this.findRepoDirs();
    if (repoDirs.length === 0) {
      console.log("[bridge] No repository found, cannot push");
      await this.sendEvent({
        type: "push_error",
        branchName,
        error: "No repository found",
      });
      return;
    }

    const repoDir = repoDirs[0];
    const token = githubToken || process.env.GITHUB_APP_TOKEN || "";

    if (!token || !repoOwner || !repoName) {
      console.log("[bridge] Push failed: missing GitHub token or repository info");
      await this.sendEvent({
        type: "push_error",
        branchName,
        error: "Push failed - GitHub authentication token is required",
      });
      return;
    }

    try {
      const pushUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
      const refspec = `HEAD:refs/heads/${branchName}`;

      console.log(`[bridge] Pushing HEAD to ${branchName} via authenticated URL`);

      const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
        const proc = spawn("git", ["push", pushUrl, refspec, "-f"], {
          cwd: repoDir,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stderr = "";
        proc.stderr?.on("data", (data) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          resolve({ code: code || 0, stderr });
        });

        proc.on("error", (err) => {
          resolve({ code: 1, stderr: err.message });
        });
      });

      if (result.code !== 0) {
        console.log("[bridge] Push failed (see event for details)");
        await this.sendEvent({
          type: "push_error",
          branchName,
          error: "Push failed - authentication may be required",
        });
      } else {
        console.log("[bridge] Push successful");
        await this.sendEvent({
          type: "push_complete",
          branchName,
        });
      }
    } catch (error) {
      console.log(`[bridge] Push error: ${error}`);
      await this.sendEvent({
        type: "push_error",
        branchName,
        error: String(error),
      });
    }
  }

  /**
   * Handle snapshot command.
   */
  private async handleSnapshot(): Promise<void> {
    console.log("[bridge] Preparing for snapshot");
    await this.sendEvent({
      type: "snapshot_ready",
      opencodeSessionId: this.opencodeSessionId ?? undefined,
    });
  }

  /**
   * Handle shutdown command.
   */
  private async handleShutdown(): Promise<void> {
    console.log("[bridge] Shutdown requested");
    this.shutdownRequested = true;
  }

  /**
   * Configure git identity for commit attribution.
   */
  private async configureGitIdentity(user: GitUser): Promise<void> {
    console.log(`[bridge] Configuring git identity: ${user.name} <${user.email}>`);

    const repoDirs = this.findRepoDirs();
    if (repoDirs.length === 0) {
      console.log("[bridge] No repository found, skipping git config");
      return;
    }

    const repoDir = repoDirs[0];

    try {
      execSync(`git config --local user.name "${user.name}"`, { cwd: repoDir });
      execSync(`git config --local user.email "${user.email}"`, { cwd: repoDir });
    } catch (error) {
      console.log(`[bridge] Failed to configure git identity: ${error}`);
    }
  }

  /**
   * Find repository directories in workspace.
   */
  private findRepoDirs(): string[] {
    const dirs: string[] = [];
    try {
      const entries = fs.readdirSync(this.repoPath);
      for (const entry of entries) {
        const gitDir = path.join(this.repoPath, entry, ".git");
        if (fs.existsSync(gitDir)) {
          dirs.push(path.join(this.repoPath, entry));
        }
      }
    } catch {
      // Workspace doesn't exist
    }
    return dirs;
  }

  /**
   * Load OpenCode session ID from file.
   */
  private async loadSessionId(): Promise<void> {
    if (!fs.existsSync(this.sessionIdFile)) {
      return;
    }

    try {
      this.opencodeSessionId = fs.readFileSync(this.sessionIdFile, "utf-8").trim();
      console.log(`[bridge] Loaded existing session ID: ${this.opencodeSessionId}`);

      // Verify session still exists
      try {
        const response = await fetch(`${this.opencodeBaseUrl}/session/${this.opencodeSessionId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          console.log("[bridge] Existing session invalid, will create new one");
          this.opencodeSessionId = null;
        }
      } catch {
        this.opencodeSessionId = null;
      }
    } catch (error) {
      console.log(`[bridge] Failed to load session ID: ${error}`);
    }
  }

  /**
   * Save OpenCode session ID to file.
   */
  private async saveSessionId(): Promise<void> {
    if (!this.opencodeSessionId) {
      return;
    }

    try {
      fs.writeFileSync(this.sessionIdFile, this.opencodeSessionId);
    } catch (error) {
      console.log(`[bridge] Failed to save session ID: ${error}`);
    }
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Parse command line arguments
const { values } = parseArgs({
  options: {
    "sandbox-id": { type: "string" },
    "session-id": { type: "string" },
    "control-plane": { type: "string" },
    token: { type: "string" },
    "opencode-port": { type: "string", default: "4096" },
  },
});

const config: BridgeConfig = {
  sandboxId: values["sandbox-id"] || "",
  sessionId: values["session-id"] || "",
  controlPlaneUrl: values["control-plane"] || "",
  authToken: values.token || "",
  opencodePort: parseInt(values["opencode-port"] || "4096", 10),
};

// Validate required arguments
if (!config.sandboxId || !config.sessionId || !config.controlPlaneUrl || !config.authToken) {
  console.error(
    "Usage: bridge --sandbox-id <id> --session-id <id> --control-plane <url> --token <token>"
  );
  process.exit(1);
}

const bridge = new AgentBridge(config);
bridge.run().catch((error) => {
  console.error(`[bridge] Fatal error: ${error}`);
  process.exit(1);
});
