/**
 * Git worktree manager.
 *
 * Creates and removes worktrees for agent sessions.
 * Uses ~/code/worktrees/ by default (configurable via WORKTREES_DIR).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const exec = promisify(execFile);

export class WorktreeManager {
  private readonly worktreesDir: string;

  constructor(worktreesDir?: string) {
    this.worktreesDir =
      worktreesDir ||
      process.env.WORKTREES_DIR ||
      path.join(process.env.HOME || "/tmp", "code", "worktrees");
  }

  /**
   * Create a new worktree for a session.
   * Returns the absolute path to the worktree.
   */
  async create(sessionId: string, repoPath: string, baseBranch?: string): Promise<string> {
    const worktreePath = path.join(this.worktreesDir, sessionId);

    // Ensure worktrees dir exists
    fs.mkdirSync(this.worktreesDir, { recursive: true });

    // Check if worktree already exists
    if (fs.existsSync(worktreePath)) {
      console.log(`[worktree] Worktree already exists at ${worktreePath}`);
      return worktreePath;
    }

    // Create a new branch from the base branch and set up the worktree
    const branch = `session/${sessionId}`;
    const startPoint = baseBranch || "HEAD";

    try {
      await exec("git", ["worktree", "add", "-b", branch, worktreePath, startPoint], {
        cwd: repoPath,
      });
      console.log(`[worktree] Created worktree at ${worktreePath} on branch ${branch}`);
    } catch (error: unknown) {
      // If branch already exists, try without -b
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("already exists")) {
        try {
          await exec("git", ["worktree", "add", worktreePath, branch], {
            cwd: repoPath,
          });
          console.log(`[worktree] Attached existing branch ${branch} at ${worktreePath}`);
        } catch (innerError) {
          const innerMsg = innerError instanceof Error ? innerError.message : String(innerError);
          throw new Error(`Failed to create worktree: ${innerMsg}`);
        }
      } else {
        throw new Error(`Failed to create worktree: ${msg}`);
      }
    }

    // Symlink gitignored config files (like the setup-worktree.sh pattern)
    await this.symlinkGitignoredFiles(repoPath, worktreePath);

    return worktreePath;
  }

  /**
   * Remove a worktree and its branch.
   */
  async remove(sessionId: string, repoPath: string): Promise<void> {
    const worktreePath = path.join(this.worktreesDir, sessionId);

    if (!fs.existsSync(worktreePath)) {
      return;
    }

    try {
      await exec("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repoPath,
      });
      console.log(`[worktree] Removed worktree at ${worktreePath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[worktree] Failed to remove worktree cleanly: ${msg}`);
      // Force remove the directory as fallback
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        await exec("git", ["worktree", "prune"], { cwd: repoPath });
      } catch {
        // Best effort
      }
    }

    // Try to delete the session branch
    const branch = `session/${sessionId}`;
    try {
      await exec("git", ["branch", "-D", branch], { cwd: repoPath });
    } catch {
      // Branch may not exist or may be checked out elsewhere
    }
  }

  /**
   * List all worktrees.
   */
  async list(repoPath: string): Promise<Array<{ path: string; branch: string; head: string }>> {
    try {
      const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
        cwd: repoPath,
      });

      const entries: Array<{ path: string; branch: string; head: string }> = [];
      let current: { path: string; branch: string; head: string } = {
        path: "",
        branch: "",
        head: "",
      };

      for (const line of stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (current.path) entries.push(current);
          current = { path: line.slice(9), branch: "", head: "" };
        } else if (line.startsWith("HEAD ")) {
          current.head = line.slice(5);
        } else if (line.startsWith("branch ")) {
          current.branch = line.slice(7).replace("refs/heads/", "");
        }
      }
      if (current.path) entries.push(current);

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Symlink gitignored files from main repo to worktree.
   * Mirrors the pattern from cia/scripts/setup-worktree.sh.
   */
  private async symlinkGitignoredFiles(repoPath: string, worktreePath: string): Promise<void> {
    try {
      const entries = fs.readdirSync(repoPath);
      for (const entry of entries) {
        // Skip directories and dotfiles other than .env*
        if (!entry.startsWith(".env") && entry.startsWith(".")) continue;
        if (entry === ".git") continue;

        const fullPath = path.join(repoPath, entry);
        if (!fs.statSync(fullPath).isFile()) continue;

        // Check if the file is gitignored
        try {
          await exec("git", ["check-ignore", "-q", entry], { cwd: repoPath });
          // If check-ignore returns 0, the file is ignored — symlink it
          const target = path.join(worktreePath, entry);
          if (!fs.existsSync(target)) {
            fs.symlinkSync(fullPath, target);
            console.log(`[worktree] Symlinked: ${entry}`);
          }
        } catch {
          // Not gitignored, skip
        }
      }
    } catch (error) {
      console.warn("[worktree] Failed to symlink gitignored files:", error);
    }
  }

  /**
   * Get the worktree path for a session (may or may not exist).
   */
  getPath(sessionId: string): string {
    return path.join(this.worktreesDir, sessionId);
  }
}
