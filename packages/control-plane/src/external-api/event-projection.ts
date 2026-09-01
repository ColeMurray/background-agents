import {
  externalEventPageSchema,
  type ExternalJsonValue,
  type ExternalEventPage,
} from "@open-inspect/shared/types/external-session-api";
import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import { sessionEventChangePageSchema } from "../session/contracts";

const OMITTED_FIELDS = new Set([
  "sandboxId",
  "ackId",
  "callbackContext",
  "scmToken",
  "scmAccessToken",
  "scmRefreshToken",
]);
const CREDENTIAL_FIELD =
  /(?:access[_-]?token|refresh[_-]?token|secret|password|authorization|cookie|credential)/i;

function redactString(value: string, secrets: ReadonlySet<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function safeJson(value: unknown, secrets: ReadonlySet<string>): ExternalJsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const projected = safeJson(entry, secrets);
      return projected === undefined ? [] : [projected];
    });
  }
  if (typeof value !== "object") return undefined;
  const projected: Record<string, ExternalJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (OMITTED_FIELDS.has(key) || CREDENTIAL_FIELD.test(key)) continue;
    const safe = safeJson(entry, secrets);
    if (safe !== undefined) projected[key] = safe;
  }
  return projected;
}

/** Parses internal events and emits an envelope safe without credential material. */
export function projectExternalEventPage(
  page: unknown,
  managedSecretValues: ReadonlySet<string> = new Set()
): ExternalEventPage {
  const parsed = sessionEventChangePageSchema.parse(page);
  return externalEventPageSchema.parse({
    changes: parsed.changes.map((change) => {
      if (change.kind === "delete") return change;
      const data = sandboxEventSchema.parse(change.event.data);
      if (data.type !== change.event.type) {
        throw new Error("Event envelope type does not match event data");
      }
      return {
        kind: change.kind,
        revision: change.revision,
        event: {
          id: change.event.id,
          type: change.event.type,
          messageId: change.event.messageId,
          createdAt: change.event.createdAt,
          data: safeJson(data, managedSecretValues) as Record<string, ExternalJsonValue>,
        },
      };
    }),
    checkpoint: parsed.checkpoint,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    hasMore: parsed.hasMore,
  });
}
