/**
 * Normalize generic webhook payloads into WebhookAutomationEvent.
 */

import type { WebhookAutomationEvent } from "../types";
import type { JsonPathFilter } from "../conditions";
import { buildWebhookContextBlock } from "./context";

/**
 * Normalize a webhook payload into a WebhookAutomationEvent.
 * Unlike other normalizers, this always succeeds (no event filtering).
 */
export function normalizeWebhookEvent(
  automationId: string,
  body: unknown,
  idempotencyKey?: string
): WebhookAutomationEvent {
  const deliveryId = idempotencyKey || generateDeliveryId();

  // Strip idempotencyKey from body before including in context
  let contextBody = body;
  if (body && typeof body === "object" && "idempotencyKey" in (body as Record<string, unknown>)) {
    const { idempotencyKey: _, ...rest } = body as Record<string, unknown>;
    contextBody = rest;
  }

  return {
    source: "webhook",
    eventType: "webhook.received",
    automationId,
    triggerKey: idempotencyKey ? `webhook:idem:${idempotencyKey}` : `webhook:${deliveryId}`,
    concurrencyKey: idempotencyKey ? `webhook:idem:${idempotencyKey}` : `webhook:${deliveryId}`,
    body,
    contextBlock: buildWebhookContextBlock(contextBody),
    meta: { deliveryId, receivedAt: Date.now() },
  };
}

/**
 * Resolve a dot-notation JSONPath against an object.
 * Supports only `$.dot.path.notation` (no array indexing, no recursive descent).
 */
export function resolveJsonPath(path: string, obj: unknown): unknown {
  if (!path.startsWith("$.")) return undefined;
  const keys = path.slice(2).split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Evaluate a single JSONPath filter against a payload body.
 */
export function evaluateJsonPathFilter(filter: JsonPathFilter, body: unknown): boolean {
  const value = resolveJsonPath(filter.path, body);
  if (filter.comparison === "exists") return value !== undefined;
  if (value === undefined) return false;

  switch (filter.comparison) {
    case "eq":
      return value === filter.value;
    case "neq":
      return value !== filter.value;
    case "gt":
      return typeof value === "number" && value > (filter.value as number);
    case "gte":
      return typeof value === "number" && value >= (filter.value as number);
    case "lt":
      return typeof value === "number" && value < (filter.value as number);
    case "lte":
      return typeof value === "number" && value <= (filter.value as number);
    case "contains":
      return typeof value === "string" && value.includes(filter.value as string);
    default:
      return false;
  }
}

function generateDeliveryId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
