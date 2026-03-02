/**
 * Helm Deployer API Service
 *
 * A small HTTP service running inside the Kubernetes cluster that receives
 * authenticated requests from the control plane and executes `helm install`
 * or `helm uninstall` commands for sandbox environments.
 *
 * Endpoints:
 *   POST /deploy  — Install a sandbox Helm release
 *   POST /delete  — Uninstall a sandbox Helm release
 *   GET  /health  — Health check
 *
 * Authentication: Bearer token verified via HMAC (same scheme as Modal API).
 */

import http from "node:http";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const PORT = parseInt(process.env.PORT || "8090");
const API_SECRET = process.env.HELM_API_SECRET || "";
const CHART_PATH = process.env.CHART_PATH || "/charts/open-inspect-sandbox";

/**
 * Verify a Bearer token using the same HMAC scheme as the control plane.
 * Token format: <timestamp_hex>.<signature_hex>
 */
function verifyToken(authorization) {
  if (!API_SECRET) return false;
  if (!authorization || !authorization.startsWith("Bearer ")) return false;

  const token = authorization.slice(7);
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;

  const timestampHex = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  // Check timestamp is within 5 minutes
  const timestamp = parseInt(timestampHex, 16);
  const now = Date.now();
  if (Math.abs(now - timestamp) > 5 * 60 * 1000) return false;

  // Verify HMAC
  const expected = crypto
    .createHmac("sha256", API_SECRET)
    .update(timestampHex)
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
  });
}

/**
 * Deploy a sandbox via `helm install`.
 */
function handleDeploy(body) {
  const {
    releaseName,
    sandboxId,
    sessionId,
    repoOwner,
    repoName,
    controlPlaneUrl,
    sandboxAuthToken,
    provider,
    model,
    branch,
    timeoutSeconds,
    tunnelToken,
    namespace,
    anthropicApiKey,
    gitCloneToken,
    userEnvVars,
  } = body;

  const setArgs = [
    `sandbox.sandboxId=${sandboxId}`,
    `sandbox.sessionId=${sessionId}`,
    `sandbox.repoOwner=${repoOwner}`,
    `sandbox.repoName=${repoName}`,
    `sandbox.controlPlaneUrl=${controlPlaneUrl}`,
    `sandbox.sandboxAuthToken=${sandboxAuthToken}`,
    `sandbox.provider=${provider || "anthropic"}`,
    `sandbox.model=${model || "claude-sonnet-4-6"}`,
    `sandbox.branch=${branch || "main"}`,
    `sandboxTtlSeconds=${timeoutSeconds || 86400}`,
  ];

  if (tunnelToken) setArgs.push(`cloudflareTunnel.tunnelToken=${tunnelToken}`);
  if (anthropicApiKey) setArgs.push(`anthropicApiKey=${anthropicApiKey}`);
  if (gitCloneToken) setArgs.push(`git.cloneToken=${gitCloneToken}`);

  // Pass user env vars as individual set values
  if (userEnvVars) {
    for (const [key, value] of Object.entries(userEnvVars)) {
      // Skip keys already handled above
      if (!["ANTHROPIC_API_KEY", "VCS_CLONE_TOKEN"].includes(key)) {
        setArgs.push(`sandbox.userEnvVars.${key}=${value}`);
      }
    }
  }

  const setString = setArgs.map((s) => `--set ${s}`).join(" ");

  const cmd = `helm install ${releaseName} ${CHART_PATH} --namespace ${namespace} --create-namespace ${setString} --wait --timeout 5m`;

  console.log(`[deployer] Installing release: ${releaseName}`);
  try {
    execSync(cmd, { stdio: "pipe", timeout: 360000 });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    console.error(`[deployer] Install failed: ${stderr}`);
    return { success: false, releaseName, sandboxId, status: "failed", createdAt: Date.now(), error: stderr };
  }

  console.log(`[deployer] Release installed: ${releaseName}`);
  return { success: true, releaseName, sandboxId, status: "deployed", createdAt: Date.now() };
}

/**
 * Delete a sandbox via `helm uninstall`.
 */
function handleDelete(body) {
  const { releaseName, namespace } = body;

  const cmd = `helm uninstall ${releaseName} --namespace ${namespace}`;
  console.log(`[deployer] Uninstalling release: ${releaseName}`);
  try {
    execSync(cmd, { stdio: "pipe", timeout: 120000 });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    console.error(`[deployer] Uninstall failed: ${stderr}`);
    return { success: false, releaseName, deleted: false, error: stderr };
  }

  console.log(`[deployer] Release uninstalled: ${releaseName}`);
  return { success: true, releaseName, deleted: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === "/health" && req.method === "GET") {
    return jsonResponse(res, 200, { status: "ok", service: "open-inspect-helm-deployer" });
  }

  // Auth check for all other endpoints
  if (!verifyToken(req.headers.authorization)) {
    return jsonResponse(res, 401, { error: "unauthorized" });
  }

  if (url.pathname === "/deploy" && req.method === "POST") {
    const body = await readBody(req);
    const result = handleDeploy(body);
    return jsonResponse(res, result.success ? 200 : 500, result);
  }

  if (url.pathname === "/delete" && req.method === "POST") {
    const body = await readBody(req);
    const result = handleDelete(body);
    return jsonResponse(res, result.success ? 200 : 500, result);
  }

  jsonResponse(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[helm-deployer] Listening on :${PORT}`);
});
