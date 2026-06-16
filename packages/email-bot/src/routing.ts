import type {
  AgentMailWebhookPayload,
  EmailRoute,
  EmailRoutesConfig,
  NormalizedEmailMessage,
} from "./types";

export type RouteResolution =
  | { ok: true; route: EmailRoute }
  | { ok: false; reason: "no_match" | "ambiguous"; matches?: EmailRoute[] };

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const email = readString(record.email || record.address);
      return email ? [email] : [];
    }
    return [];
  });
}

export function extractEmailAddress(value: string): string {
  return (value.match(EMAIL_RE)?.[0] || value).trim().toLowerCase();
}

function normalizeList(values?: string[]): string[] {
  return (values || []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function domainOf(email: string): string {
  return email.includes("@") ? email.split("@").pop() || "" : "";
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((item) => set.has(item));
}

export function parseRoutesConfig(raw: string | undefined): EmailRoutesConfig {
  if (!raw?.trim()) return { routes: [] };
  const parsed = JSON.parse(raw) as EmailRoutesConfig;
  return { routes: Array.isArray(parsed.routes) ? parsed.routes : [] };
}

export function normalizeAgentMailMessage(
  payload: AgentMailWebhookPayload
): NormalizedEmailMessage {
  const message = payload.message || {};
  const inboxId = readString(message.inbox_id || message.inboxId);
  const threadId = readString(message.thread_id || message.threadId);
  const messageId = readString(message.message_id || message.messageId);
  const from = readString(message.from);
  const text = readString(message.extracted_text || message.extractedText || message.text);

  if (!inboxId || !threadId || !messageId || !from) {
    throw new Error("AgentMail message payload missing inboxId, threadId, messageId, or from");
  }

  return {
    inboxId,
    threadId,
    messageId,
    from,
    senderEmail: extractEmailAddress(from),
    to: readStringArray(message.to).map(extractEmailAddress),
    cc: readStringArray(message.cc).map(extractEmailAddress),
    bcc: readStringArray(message.bcc).map(extractEmailAddress),
    subject: readString(message.subject),
    text,
    html: readString(message.html) || undefined,
    extractedText: readString(message.extracted_text || message.extractedText) || undefined,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    labels: readStringArray(message.labels),
    size: typeof message.size === "number" ? message.size : undefined,
  };
}

function routeMatches(route: EmailRoute, message: NormalizedEmailMessage): boolean {
  const inboxIds = normalizeList(route.inboxIds);
  if (inboxIds.length > 0 && !inboxIds.includes(message.inboxId.toLowerCase())) return false;

  const recipients = normalizeList(route.recipientAddresses).map(extractEmailAddress);
  if (recipients.length > 0) {
    const messageRecipients = [...message.to, ...message.cc, ...message.bcc].map(
      extractEmailAddress
    );
    if (!intersects(recipients, messageRecipients)) return false;
  }

  const allowedSenders = normalizeList(route.allowedSenders).map(extractEmailAddress);
  const allowedDomains = normalizeList(route.allowedDomains);
  if (allowedSenders.length === 0 && allowedDomains.length === 0) return false;

  if (allowedSenders.includes(message.senderEmail)) return true;
  return allowedDomains.includes(domainOf(message.senderEmail));
}

export function resolveEmailRoute(
  config: EmailRoutesConfig,
  message: NormalizedEmailMessage
): RouteResolution {
  const matches = config.routes.filter((route) => routeMatches(route, message));
  if (matches.length === 0) return { ok: false, reason: "no_match" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };
  return { ok: true, route: matches[0] };
}

export function threadKey(inboxId: string, threadId: string): string {
  return `thread:${inboxId}:${threadId}`;
}

export function eventKey(eventId: string): string {
  return `event:${eventId}`;
}
