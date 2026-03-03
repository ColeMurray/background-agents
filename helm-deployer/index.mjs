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

const { process, Buffer, console } = globalThis;

const PORT = parseInt(process.env.PORT || "80");
const API_SECRET = process.env.HELM_API_SECRET || "";
const CHART_PATH = process.env.CHART_PATH || "/charts/open-inspect-sandbox";
const HELM_NAMESPACE = process.env.HELM_NAMESPACE || "";
const HELM_CREATE_NAMESPACE = process.env.HELM_CREATE_NAMESPACE === "true";
const AUTH_DEBUG = process.env.AUTH_DEBUG === "true";
const INGRESS_ENABLED = process.env.INGRESS_ENABLED === "true";
const INGRESS_CLASS_NAME = process.env.INGRESS_CLASS_NAME || "";
const INGRESS_BASE_DOMAIN = process.env.INGRESS_BASE_DOMAIN || "";

// ---------------------------------------------------------------------------
// Environment number pool (0000–9999)
//
// Each sandbox with ingress enabled gets a unique 4-digit number used as its
// subdomain prefix (env-NNNN.<baseDomain>). The pool is kept in memory; state
// is recovered from existing Kubernetes Ingress resources on startup so that
// a deployer restart does not re-assign numbers that are already in use.
// ---------------------------------------------------------------------------

const ENV_NUMBER_MAX = 9999;

/** Maps releaseName → envNumber (integer 0–9999). */
const assignedEnvNumbers = new Map();

/** Fast membership check for which numbers are currently in use. */
const usedEnvNumbers = new Set();

/**
 * Recover environment number assignments from existing Ingress resources.
 * Called once on startup so that a pod restart doesn't double-assign numbers.
 */
function initEnvPool(namespace) {
  if (!INGRESS_ENABLED || !namespace) return;
  try {
    const jsonOutput = execSync(
      `kubectl get ingress -n ${namespace} -l app.kubernetes.io/name=open-inspect-sandbox -o json`,
      { stdio: "pipe", timeout: 15000 },
    )
      .toString()
      .trim();

    if (!jsonOutput) return;
    const ingresses = JSON.parse(jsonOutput);
    let recovered = 0;
    for (const item of ingresses.items || []) {
      const releaseName = item.metadata?.labels?.["app.kubernetes.io/instance"];
      const envNumStr = item.metadata?.annotations?.["open-inspect/env-number"];
      if (!releaseName || !envNumStr) continue;
      const envNum = parseInt(envNumStr, 10);
      if (!Number.isFinite(envNum) || envNum < 0 || envNum > ENV_NUMBER_MAX) continue;
      assignedEnvNumbers.set(releaseName, envNum);
      usedEnvNumbers.add(envNum);
      recovered++;
    }
    console.log(`[deployer] Recovered ${recovered} env number assignments from Kubernetes`);
  } catch (err) {
    console.warn(`[deployer] Failed to recover env pool from Kubernetes (continuing): ${err.message}`);
  }
}

/**
 * Allocate the lowest available environment number for a release.
 * Returns a 4-digit zero-padded string (e.g. "0042"), or null if exhausted.
 * Idempotent: calling with the same releaseName returns the same number.
 */
function allocateEnvNumber(releaseName) {
  if (assignedEnvNumbers.has(releaseName)) {
    return String(assignedEnvNumbers.get(releaseName)).padStart(4, "0");
  }
  for (let n = 0; n <= ENV_NUMBER_MAX; n++) {
    if (!usedEnvNumbers.has(n)) {
      usedEnvNumbers.add(n);
      assignedEnvNumbers.set(releaseName, n);
      return String(n).padStart(4, "0");
    }
  }
  return null; // pool exhausted (all 10 000 slots in use)
}

/**
 * Release an environment number back to the pool when a sandbox is deleted.
 */
function releaseEnvNumber(releaseName) {
  const n = assignedEnvNumbers.get(releaseName);
  if (n !== undefined) {
    usedEnvNumbers.delete(n);
    assignedEnvNumbers.delete(releaseName);
    console.log(`[deployer] Released env number ${String(n).padStart(4, "0")} from ${releaseName}`);
  }
}

function verifyToken(authorization) {
  if (!API_SECRET) {
    return { ok: false, reason: "missing_api_secret" };
  }
  if (!authorization) {
    return { ok: false, reason: "missing_authorization_header" };
  }
  if (!authorization.startsWith("Bearer ")) {
    return { ok: false, reason: "authorization_not_bearer" };
  }

  const token = authorization.slice(7);
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) {
    return { ok: false, reason: "invalid_token_format" };
  }

  const timestampPart = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (!timestampPart || !signature) {
    return { ok: false, reason: "missing_token_parts" };
  }

  // Shared package emits decimal timestamp; accept hex too for backward compatibility.
  const isDecimalTimestamp = /^\d+$/.test(timestampPart);
  const isHexTimestamp = /^[0-9a-fA-F]+$/.test(timestampPart);
  if (!isDecimalTimestamp && !isHexTimestamp) {
    return { ok: false, reason: "invalid_timestamp_format" };
  }

  const timestamp = parseInt(timestampPart, isDecimalTimestamp ? 10 : 16);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "invalid_timestamp_number" };
  }

  // Check timestamp is within 5 minutes.
  const now = Date.now();
  const skewMs = now - timestamp;
  if (Math.abs(skewMs) > 5 * 60 * 1000) {
    return { ok: false, reason: "token_expired_or_clock_skew", skewMs };
  }

  // Verify HMAC against timestamp string exactly as sent in token.
  const expected = crypto.createHmac("sha256", API_SECRET).update(timestampPart).digest("hex");
  if (signature.length !== expected.length) {
    return { ok: false, reason: "signature_length_mismatch" };
  }

  const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true, reason: "ok", skewMs };
}

function logUnauthorized(req, authResult) {
  const authHeader = req.headers.authorization;
  const hasBearer = Boolean(authHeader && authHeader.startsWith("Bearer "));
  const tokenPreview =
    hasBearer && authHeader.length > 20 ? `${authHeader.slice(0, 20)}...` : hasBearer ? "short_token" : "none";

  const payload = {
    method: req.method,
    path: req.url,
    reason: authResult.reason,
    hasAuthorizationHeader: Boolean(authHeader),
    hasBearerPrefix: hasBearer,
    tokenPreview,
    xRequestId: req.headers["x-request-id"] || null,
    xTraceId: req.headers["x-trace-id"] || null,
    userAgent: req.headers["user-agent"] || null,
  };

  if (AUTH_DEBUG) {
    payload.skewMs = authResult.skewMs ?? null;
    payload.authorizationHeaderLength = authHeader?.length ?? 0;
  }

  console.warn("[deployer] Unauthorized request", payload);
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
    agent,
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

  if (agent) setArgs.push(`sandbox.agent=${agent}`);
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

  // Assign an ingress environment number when ingress is enabled.
  let envNumber = null;
  if (INGRESS_ENABLED && INGRESS_BASE_DOMAIN) {
    envNumber = allocateEnvNumber(releaseName);
    if (!envNumber) {
      return {
        success: false,
        releaseName,
        sandboxId,
        status: "failed",
        createdAt: Date.now(),
        error: "env number pool exhausted: all 10 000 slots (0000–9999) are in use",
      };
    }
    setArgs.push(`ingress.enabled=true`);
    setArgs.push(`ingress.baseDomain=${INGRESS_BASE_DOMAIN}`);
    setArgs.push(`ingress.envNumber=${envNumber}`);
    if (INGRESS_CLASS_NAME) setArgs.push(`ingress.className=${INGRESS_CLASS_NAME}`);
  }

  const setString = setArgs.map((s) => `--set ${s}`).join(" ");

  const targetNamespace = HELM_NAMESPACE || namespace;
  if (!targetNamespace) {
    // Free the env number — helm install won't run.
    if (envNumber) releaseEnvNumber(releaseName);
    return {
      success: false,
      releaseName,
      sandboxId,
      status: "failed",
      createdAt: Date.now(),
      error: "namespace is required",
    };
  }

  const createNamespaceFlag = HELM_CREATE_NAMESPACE ? "--create-namespace" : "";
  const cmd =
    `helm install ${releaseName} ${CHART_PATH} --namespace ${targetNamespace} ${createNamespaceFlag} ` +
    `${setString} --wait --timeout 5m`;

  console.log(`[deployer] Installing release: ${releaseName}${envNumber ? ` (env-${envNumber})` : ""}`);
  try {
    execSync(cmd, { stdio: "pipe", timeout: 360000 });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    console.error(`[deployer] Install failed: ${stderr}`);
    // Return the env number to the pool so it can be reused.
    if (envNumber) releaseEnvNumber(releaseName);
    return {
      success: false,
      releaseName,
      sandboxId,
      status: "failed",
      createdAt: Date.now(),
      error: stderr,
    };
  }

  console.log(`[deployer] Release installed: ${releaseName}`);
  return {
    success: true,
    releaseName,
    sandboxId,
    status: "deployed",
    createdAt: Date.now(),
    ...(envNumber && { envNumber, ingressHost: `env-${envNumber}.${INGRESS_BASE_DOMAIN}` }),
  };
}

/**
 * Delete a sandbox via `helm uninstall`.
 */
function handleDelete(body) {
  const { releaseName, namespace } = body;
  const targetNamespace = HELM_NAMESPACE || namespace;
  if (!targetNamespace) {
    return { success: false, releaseName, deleted: false, error: "namespace is required" };
  }

  const cmd = `helm uninstall ${releaseName} --namespace ${targetNamespace}`;
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
  const url = new globalThis.URL(req.url, `http://localhost`);

  if (url.pathname === "/health" && req.method === "GET") {
    return jsonResponse(res, 200, { status: "ok", service: "open-inspect-helm-deployer" });
  }

  // Auth check for all other endpoints.
  const authResult = verifyToken(req.headers.authorization);
  if (!authResult.ok) {
    logUnauthorized(req, authResult);
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
    if (result.success) releaseEnvNumber(body.releaseName);
    return jsonResponse(res, result.success ? 200 : 500, result);
  }

  jsonResponse(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[helm-deployer] Listening on :${PORT}`);
  // Recover env number assignments from existing Kubernetes Ingress resources
  // so that a restart does not re-assign numbers already in use.
  initEnvPool(HELM_NAMESPACE);
});
