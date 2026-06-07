#!/usr/bin/env node

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { Islo, IsloApiError } from "@islo-labs/sdk";
import {
  DEFAULT_BASE_IMAGE,
  SANDBOX_RUNTIME_DIR,
  buildBaseSandboxCreate,
  buildSetupScript,
} from "./toolchain.js";

const SNAPSHOT_DELETE_TIMEOUT_MS = 300_000;
const SNAPSHOT_DELETE_POLL_MS = 5_000;
const SNAPSHOT_CREATE_TIMEOUT_MS = 900_000;
const SNAPSHOT_CREATE_POLL_MS = 10_000;
const SANDBOX_READY_TIMEOUT_MS = 900_000;
const SANDBOX_READY_POLL_MS = 5_000;
const EXEC_TIMEOUT_MS = 120_000;
const EXEC_POLL_MS = 2_000;
const DEFAULT_ISLO_BASE_URL = "https://api.islo.dev";

function loadConfig() {
  const apiKey = process.env.ISLO_API_KEY;
  if (!apiKey) {
    throw new Error("ISLO_API_KEY is required");
  }

  const baseSnapshot = process.env.ISLO_BASE_SNAPSHOT;
  if (!baseSnapshot) {
    throw new Error("ISLO_BASE_SNAPSHOT is required");
  }

  return {
    apiKey,
    baseUrl: process.env.ISLO_BASE_URL || undefined,
    baseSnapshot,
    baseImage: process.env.ISLO_BASE_IMAGE || DEFAULT_BASE_IMAGE,
  };
}

function parseArgs(argv) {
  return {
    force: argv.includes("--force"),
  };
}

function isNotFound(error) {
  return error instanceof IsloApiError && error.statusCode === 404;
}

function isResourceUnavailable(error) {
  return (
    error instanceof IsloApiError &&
    error.statusCode === 503 &&
    error.body &&
    error.body.code === "RESOURCE_UNAVAILABLE"
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSnapshotDeletion(client, name) {
  const deadline = Date.now() + SNAPSHOT_DELETE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await client.snapshots.getSnapshot({ name });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    console.log(`Waiting for snapshot ${JSON.stringify(name)} deletion to complete...`);
    await sleep(SNAPSHOT_DELETE_POLL_MS);
  }
  throw new Error(`Snapshot ${JSON.stringify(name)} still present after delete timeout`);
}

async function createSnapshotWithRetry(client, params) {
  const deadline = Date.now() + SNAPSHOT_CREATE_TIMEOUT_MS;
  for (;;) {
    try {
      return await client.snapshots.createSnapshot(params);
    } catch (error) {
      if (!isResourceUnavailable(error) || Date.now() >= deadline) {
        throw error;
      }
      console.log(
        `Snapshot resources unavailable; retrying in ${SNAPSHOT_CREATE_POLL_MS / 1000}s...`
      );
      await sleep(SNAPSHOT_CREATE_POLL_MS);
    }
  }
}

async function waitForSandboxRunning(client, sandboxName) {
  const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const sandbox = await client.sandboxes.getSandbox({ sandbox_name: sandboxName });
    lastStatus = sandbox.status || "unknown";
    if (sandbox.status === "running") {
      return sandbox;
    }
    if (["failed", "error", "deleted"].includes(sandbox.status || "")) {
      throw new Error(`Build sandbox entered terminal state: ${sandbox.status}`);
    }
    await sleep(SANDBOX_READY_POLL_MS);
  }
  throw new Error(`Timed out waiting for build sandbox to run (last status: ${lastStatus})`);
}

async function execAndWait(client, sandboxName, body, timeoutMs = EXEC_TIMEOUT_MS) {
  const exec = await client.sandboxes.execInSandbox(
    { sandbox_name: sandboxName, body },
    { timeoutInSeconds: 30 }
  );
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await client.sandboxes.getExecResult(
      { sandbox_name: sandboxName, exec_id: exec.exec_id },
      { timeoutInSeconds: 15 }
    );
    if (result.status === "completed" || result.status === "failed") {
      if (result.status === "failed" || (result.exit_code != null && result.exit_code !== 0)) {
        throw new Error(
          `Exec failed with exit code ${result.exit_code}: ${result.stderr || result.stdout || result.status}`
        );
      }
      return result;
    }
    await sleep(EXEC_POLL_MS);
  }

  throw new Error(`Timed out waiting for exec ${exec.exec_id}`);
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function createRuntimeArchive(setupScript) {
  const tmp = await mkdtemp(join(tmpdir(), "open-inspect-islo-runtime-"));
  const stageDir = join(tmp, "stage");
  const archivePath = join(tmp, "sandbox-runtime.tar.gz");
  await cp(SANDBOX_RUNTIME_DIR, join(stageDir, "sandbox_runtime"), {
    recursive: true,
    force: true,
    filter: (source) => {
      const name = basename(source);
      return name !== ".DS_Store" && name !== "__MACOSX" && !name.startsWith("._");
    },
  });
  await writeFile(join(stageDir, "open-inspect-islo-setup.sh"), setupScript, { mode: 0o755 });
  await run("tar", ["-czf", archivePath, "-C", stageDir, "."]);
  return { tmp, archivePath };
}

async function uploadRuntimeArchive(client, sandboxName, baseUrl, setupScript) {
  const { tmp, archivePath } = await createRuntimeArchive(setupScript);
  try {
    const archive = await import("node:fs/promises").then((fs) => fs.readFile(archivePath));
    const uploadUrl = new URL(
      `/sandboxes/${encodeURIComponent(sandboxName)}/files-archive`,
      baseUrl
    );
    uploadUrl.searchParams.set("path", "/app");
    const form = new FormData();
    form.append(
      "file",
      new Blob([archive], { type: "application/gzip" }),
      "sandbox-runtime.tar.gz"
    );
    const response = await client.fetch(
      uploadUrl,
      {
        method: "POST",
        body: form,
      },
      { timeoutInSeconds: 120 }
    );
    if (!response.ok) {
      throw new Error(`Runtime archive upload failed: ${response.status} ${await response.text()}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function verifyRuntime(client, sandboxName) {
  await execAndWait(
    client,
    sandboxName,
    {
      command: [
        "sh",
        "-lc",
        [
          "python3 - <<'PY'",
          "import sandbox_runtime.entrypoint",
          "print('sandbox_runtime ok')",
          "PY",
          "python --version",
          "bun --version",
          "opencode --version",
          "ttyd --version",
          "agent-browser --version",
          "code-server --version >/tmp/code-server-version",
          "chromium --version",
        ].join("\n"),
      ],
      workdir: "/workspace",
      timeout_secs: 60,
    },
    120_000
  );
}

async function installRuntimeToolchain(client, sandboxName) {
  await execAndWait(
    client,
    sandboxName,
    {
      command: [
        "sh",
        "-lc",
        "chmod +x /app/open-inspect-islo-setup.sh && /app/open-inspect-islo-setup.sh",
      ],
      workdir: "/workspace",
      timeout_secs: 1800,
    },
    1_900_000
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const client = new Islo({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });

  if (args.force) {
    try {
      const existing = await client.snapshots.getSnapshot({ name: config.baseSnapshot });
      await client.snapshots.deleteSnapshot({ name: existing.name });
      await waitForSnapshotDeletion(client, config.baseSnapshot);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  const sandboxName = `open-inspect-snapshot-build-${Date.now()}`;
  let sandbox;
  try {
    const setupScript = await buildSetupScript();
    console.log(`Creating Islo build sandbox ${sandboxName} from ${config.baseImage}`);
    sandbox = await client.sandboxes.createSandbox(
      buildBaseSandboxCreate({
        sandboxName,
        baseImage: config.baseImage,
      }),
      { timeoutInSeconds: 1800 }
    );

    sandbox = await waitForSandboxRunning(client, sandboxName);
    console.log(`Uploading sandbox_runtime into ${sandboxName}`);
    await uploadRuntimeArchive(
      client,
      sandboxName,
      config.baseUrl || DEFAULT_ISLO_BASE_URL,
      setupScript
    );
    console.log("Installing runtime dependencies");
    await installRuntimeToolchain(client, sandboxName);
    console.log("Verifying runtime dependencies");
    await verifyRuntime(client, sandboxName);

    console.log(`Creating Islo snapshot ${config.baseSnapshot}`);
    await createSnapshotWithRetry(client, {
      sandbox_id: sandbox.id,
      sandbox_name: sandboxName,
      name: config.baseSnapshot,
    });
    console.log(`Islo snapshot ${config.baseSnapshot} built successfully`);
  } finally {
    if (sandboxName) {
      try {
        await client.sandboxes.deleteSandbox({ sandbox_name: sandboxName });
      } catch (error) {
        if (!isNotFound(error)) {
          console.warn(`Failed to delete build sandbox ${sandboxName}: ${error}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
