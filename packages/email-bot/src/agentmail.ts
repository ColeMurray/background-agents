import type { Env } from "./types";

function apiBase(env: Env): string {
  return (env.AGENTMAIL_API_BASE_URL || "https://api.agentmail.to").replace(/\/+$/, "");
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${htmlEscape(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export async function replyToMessage(params: {
  env: Env;
  inboxId: string;
  messageId: string;
  text: string;
  html?: string;
  labels?: string[];
}): Promise<void> {
  const { env, inboxId, messageId, text, html, labels } = params;
  const response = await fetch(
    `${apiBase(env)}/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(
      messageId
    )}/reply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        html: html || textToHtml(text),
        labels,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AgentMail reply failed: ${response.status} ${body.slice(0, 500)}`);
  }
}

export async function markMessageProcessed(params: {
  env: Env;
  inboxId: string;
  messageId: string;
}): Promise<void> {
  const { env, inboxId, messageId } = params;
  const response = await fetch(
    `${apiBase(env)}/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(
      messageId
    )}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.AGENTMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        add_labels: ["processed"],
        remove_labels: ["unreplied"],
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AgentMail label update failed: ${response.status} ${body.slice(0, 500)}`);
  }
}
