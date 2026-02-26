/**
 * Docker container manager for sandbox environments.
 *
 * Each session gets a Docker container with:
 * - The git worktree mounted at /workspace
 * - Host SSH keys, git config, and gh CLI config mounted read-only
 * - OpenCode server + bridge running inside
 *
 * Replaces Modal's cloud sandbox system.
 */

import Dockerode from "dockerode";
import path from "node:path";
import os from "node:os";

const IMAGE_NAME = process.env.SANDBOX_IMAGE || "background-agents-sandbox";
const HOME = os.homedir();

export class DockerManager {
  private docker: Dockerode;

  constructor() {
    this.docker = new Dockerode();
  }

  /**
   * Check if Docker is available and the sandbox image exists.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.docker.ping();
    } catch {
      return { ok: false, error: "Docker daemon is not running. Start Docker Desktop." };
    }

    try {
      await this.docker.getImage(IMAGE_NAME).inspect();
    } catch {
      return {
        ok: false,
        error: `Sandbox image '${IMAGE_NAME}' not found. Run: docker build -t ${IMAGE_NAME} packages/sandbox/`,
      };
    }

    return { ok: true };
  }

  /**
   * Create and start a sandbox container for a session.
   */
  async createSandbox(options: {
    sessionId: string;
    worktreePath: string;
    serverPort: number;
    env?: Record<string, string>;
  }): Promise<{ containerId: string }> {
    const { sessionId, worktreePath, serverPort, env = {} } = options;
    const containerName = `ba-session-${sessionId}`;

    // Check if a container with this name already exists
    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      if (info.State.Running) {
        return { containerId: info.Id };
      }
      // Remove stopped container
      await existing.remove({ force: true });
    } catch {
      // Container doesn't exist, continue
    }

    // Build environment variables for the container
    const containerEnv: string[] = [
      `SANDBOX_ID=${sessionId}`,
      `SESSION_ID=${sessionId}`,
      `CONTROL_PLANE_URL=ws://host.docker.internal:${serverPort}`,
      `CONTROL_PLANE_WS_URL=ws://host.docker.internal:${serverPort}/sessions/${sessionId}/ws?type=sandbox`,
    ];

    // Pass through LLM API keys from host .env
    const apiKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
    for (const key of apiKeys) {
      const value = env[key] || process.env[key];
      if (value) containerEnv.push(`${key}=${value}`);
    }

    // Add any additional env vars
    for (const [key, value] of Object.entries(env)) {
      if (!apiKeys.includes(key)) {
        containerEnv.push(`${key}=${value}`);
      }
    }

    // Volume mounts
    const binds: string[] = [`${worktreePath}:/workspace`];

    // Mount host credentials read-only for git push / gh CLI
    const optionalMounts: Array<[string, string]> = [
      [path.join(HOME, ".ssh"), "/root/.ssh:ro"],
      [path.join(HOME, ".gitconfig"), "/root/.gitconfig:ro"],
      [path.join(HOME, ".config", "gh"), "/root/.config/gh:ro"],
    ];

    for (const [hostPath, containerPath] of optionalMounts) {
      try {
        const stat = await import("node:fs").then((fs) => fs.statSync(hostPath));
        if (stat) binds.push(`${hostPath}:${containerPath}`);
      } catch {
        // Path doesn't exist, skip
      }
    }

    const container = await this.docker.createContainer({
      name: containerName,
      Image: IMAGE_NAME,
      Env: containerEnv,
      WorkingDir: "/workspace",
      HostConfig: {
        Binds: binds,
        // Use host networking for simplicity (macOS Docker Desktop
        // automatically routes host.docker.internal)
        NetworkMode: "bridge",
        // Limit resources for safety
        Memory: 4 * 1024 * 1024 * 1024, // 4GB
        NanoCpus: 2 * 1e9, // 2 CPUs
      },
      // Labels for easy identification
      Labels: {
        "background-agents": "true",
        "session-id": sessionId,
      },
    });

    await container.start();
    console.log(`[docker] Started container ${containerName} (${container.id.slice(0, 12)})`);

    return { containerId: container.id };
  }

  /**
   * Stop a sandbox container.
   */
  async stopSandbox(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 10 });
      console.log(`[docker] Stopped container ${containerId.slice(0, 12)}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes("not running") && !msg.includes("No such container")) {
        console.warn(`[docker] Failed to stop container: ${msg}`);
      }
    }
  }

  /**
   * Remove a sandbox container.
   */
  async removeSandbox(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.remove({ force: true });
      console.log(`[docker] Removed container ${containerId.slice(0, 12)}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes("No such container")) {
        console.warn(`[docker] Failed to remove container: ${msg}`);
      }
    }
  }

  /**
   * Check if a container is running.
   */
  async isRunning(containerId: string): Promise<boolean> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return info.State.Running;
    } catch {
      return false;
    }
  }

  /**
   * Get logs from a container.
   */
  async getLogs(containerId: string, tail?: number): Promise<string> {
    try {
      const container = this.docker.getContainer(containerId);
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail: tail ?? 100,
      });
      return logs.toString();
    } catch {
      return "";
    }
  }

  /**
   * List all background-agents containers.
   */
  async listContainers(): Promise<
    Array<{ id: string; sessionId: string; state: string; status: string }>
  > {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["background-agents=true"] },
    });

    return containers.map((c) => ({
      id: c.Id,
      sessionId: c.Labels["session-id"] || "unknown",
      state: c.State,
      status: c.Status,
    }));
  }

  /**
   * Clean up all stopped background-agents containers.
   */
  async cleanup(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: ["background-agents=true"],
        status: ["exited", "dead"],
      },
    });

    let count = 0;
    for (const c of containers) {
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
        count++;
      } catch {
        // Best effort
      }
    }

    return count;
  }
}
