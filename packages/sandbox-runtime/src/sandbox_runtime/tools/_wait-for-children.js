import { formatChildDetail, formatStatus } from "./get-child-status-format.js";

const INACTIVE_STATUSES = new Set(["completed", "failed", "archived", "cancelled"]);
const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;

function sleepMs(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function responseError(response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return body.error || body.message || text;
  } catch {
    return text;
  }
}

async function loadChildren(request) {
  const response = await request("/children");
  if (!response.ok) {
    throw new Error(
      `Failed to list children: ${await responseError(response)} (HTTP ${response.status})`
    );
  }
  const body = await response.json();
  return Array.isArray(body.children) ? body.children : [];
}

async function loadTerminalResult(childId, request) {
  const response = await request(`/children/${encodeURIComponent(childId)}?include=result`);
  if (!response.ok) {
    return `Child: ${childId}\n  Result unavailable: ${await responseError(response)} (HTTP ${response.status})`;
  }
  return formatChildDetail(await response.json(), childId, { includeResponse: true });
}

function statusLines(childIds, childrenById) {
  return childIds.map((childId) => {
    const child = childrenById.get(childId);
    return `  [${formatStatus(child?.status || "unknown")}] ${childId}`;
  });
}

export async function waitForChildren(
  { childIds, timeoutSeconds = 900 },
  { request, sleep = sleepMs, now = Date.now }
) {
  const ids = [...new Set(childIds)];
  const deadline = now() + timeoutSeconds * 1_000;
  let delayMs = INITIAL_DELAY_MS;

  while (true) {
    const children = await loadChildren(request);
    const childrenById = new Map(children.map((child) => [child.id, child]));
    const missing = ids.filter((childId) => !childrenById.has(childId));
    if (missing.length > 0) {
      return `Cannot wait for unknown direct child session(s): ${missing.join(", ")}`;
    }

    const active = ids.filter(
      (childId) => !INACTIVE_STATUSES.has(childrenById.get(childId)?.status)
    );
    if (active.length === 0) {
      const results = await Promise.all(ids.map((childId) => loadTerminalResult(childId, request)));
      return [`All ${ids.length} child session(s) reached terminal states.`, ...results].join(
        "\n\n---\n\n"
      );
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return [
        `Timed out after ${timeoutSeconds}s waiting for ${active.length} child session(s).`,
        ...statusLines(ids, childrenById),
        "Call wait-for-children again with the same IDs when their results are needed.",
      ].join("\n");
    }

    await sleep(Math.min(delayMs, remainingMs));
    delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
  }
}
