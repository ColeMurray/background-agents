import {
  externalEventPageSchema,
  type ExternalEventPage,
  type ExternalJsonValue,
} from "@open-inspect/shared/types/external-session-api";
import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import { sessionEventChangePageSchema } from "../session/contracts";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "secret",
  "secrets",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "scmtokenencrypted",
  "canonicaluserid",
  "modalobjectid",
  "modalsandboxid",
  "opencodesessionid",
  "participantuserid",
  "sandboxid",
  "scmemail",
  "scmlogin",
  "scmname",
  "scmuserid",
  "userid",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function redactString(value: string, managedSecretValues: readonly string[]): string {
  return managedSecretValues.reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    value
  );
}

function sanitize(value: unknown, managedSecretValues: readonly string[]): ExternalJsonValue {
  if (typeof value === "string") return redactString(value, managedSecretValues);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, managedSecretValues));
  if (typeof value !== "object") return null;
  return sanitizeRecord(value, managedSecretValues);
}

function sanitizeRecord(
  value: object,
  managedSecretValues: readonly string[]
): { [key: string]: ExternalJsonValue } {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEYS.has(normalizedKey(key)))
      .map(([key, child]) => [key, sanitize(child, managedSecretValues)])
  );
}

/**
 * Parses the internal event page before projecting its stable external envelope.
 * Extensible event data retains legitimate fields while exact sensitive keys are omitted.
 */
export function projectExternalEventPage(
  page: unknown,
  managedSecretValues: ReadonlySet<string> = new Set()
): ExternalEventPage {
  const parsed = sessionEventChangePageSchema.parse(page);
  const secrets = [...managedSecretValues].filter(Boolean).sort((a, b) => b.length - a.length);
  return externalEventPageSchema.parse({
    changes: parsed.changes.map((change) => {
      if (change.kind === "delete") {
        return {
          kind: change.kind,
          revision: change.revision,
          eventId: redactString(change.eventId, secrets),
        };
      }
      const data = sandboxEventSchema.parse(change.event.data);
      if (data.type !== change.event.type)
        throw new Error("Event envelope type does not match event data");
      return {
        kind: change.kind,
        revision: change.revision,
        event: {
          id: redactString(change.event.id, secrets),
          type: change.event.type,
          messageId:
            change.event.messageId === null ? null : redactString(change.event.messageId, secrets),
          createdAt: change.event.createdAt,
          data: sanitizeRecord(data, secrets),
        },
      };
    }),
    checkpoint: parsed.checkpoint,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    hasMore: parsed.hasMore,
  });
}
