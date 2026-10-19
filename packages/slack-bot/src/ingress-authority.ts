import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env, SlackEventPayload } from "./types";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "./request-options";

export const SLACK_INGRESS_QUEUE_VERSION = 1 as const;
export const slackIngressJobSchema = z.strictObject({
  version: z.literal(SLACK_INGRESS_QUEUE_VERSION),
  receiptId: z.string().min(1).max(128),
  eventId: z.string().min(1).max(255),
  admittedAt: z.number().int().nonnegative(),
});
export type SlackIngressJob = z.infer<typeof slackIngressJobSchema>;
const receiptEnvelopeSchema = z.object({
  receipt: z.looseObject({
    id: z.string(),
    state: z.string(),
    payload_json: z.string().nullable(),
    external_event_id: z.string(),
    channel_id: z.string(),
    thread_ts: z.string().nullable(),
    stable_session_id: z.string(),
    stable_message_id: z.string(),
    session_id: z.string().nullable(),
    thread_mapping_json: z.string().nullable().optional(),
  }),
  created: z.boolean().optional(),
});

async function call(env: Env, path: string, method: string, body?: unknown) {
  const response = await signedControlPlaneFetch(
    env,
    {
      method,
      url: `https://internal${path}`,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    }
  );
  const json = await response.json().catch(() => null);
  return { response, json };
}
async function sha256Hex(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function admitSlackIngress(
  env: Env,
  payload: SlackEventPayload,
  raw: string,
  now = Date.now()
) {
  if (payload.type !== "event_callback" || !payload.event_id || !payload.event)
    throw new Error("Slack event is not durably admissible");
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength > 262_144) throw new Error("Slack event is too large");
  const hash = await sha256Hex(bytes);
  const event = payload.event;
  const channel = event.channel;
  if (!channel) throw new Error("Slack event channel is required");
  const externalEventId = payload.event_id;
  const eventHash = await sha256Hex(new TextEncoder().encode(`slack\0${externalEventId}`));
  const stableSuffix = eventHash.slice(0, 20);
  const { response, json } = await call(env, "/internal/slack-ingress", "POST", {
    source: "slack",
    externalEventId,
    payloadJson: raw,
    payloadSha256: hash,
    channelId: channel,
    threadTs: event.thread_ts ?? event.ts,
    stableSessionId: `slack-session-${stableSuffix}`,
    stableMessageId: `slack-message-${stableSuffix}`,
    deadlineAt: now + 15 * 60_000,
  });
  if (response.status !== 201 && response.status !== 200 && response.status !== 409)
    throw new Error(`Slack ingress admission failed (${response.status})`);
  if (response.status === 409) throw new Error("Slack ingress admission conflict");
  return receiptEnvelopeSchema.parse(json);
}
export async function getSlackIngress(env: Env, id: string) {
  const { response, json } = await call(
    env,
    `/internal/slack-ingress/${encodeURIComponent(id)}`,
    "GET"
  );
  if (!response.ok) throw new Error(`Slack ingress read failed (${response.status})`);
  return receiptEnvelopeSchema.parse(json).receipt;
}
export async function claimSlackIngress(env: Env, id: string, leaseOwner: string) {
  const { response, json } = await call(
    env,
    `/internal/slack-ingress/${encodeURIComponent(id)}/claim`,
    "POST",
    { leaseOwner, leaseMs: 60_000 }
  );
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`Slack ingress claim failed (${response.status})`);
  return receiptEnvelopeSchema.parse(json).receipt;
}
export async function transitionSlackIngress(
  env: Env,
  id: string,
  leaseOwner: string,
  expectedState: string,
  state: string,
  errorCode?: string,
  sessionId?: string,
  threadMapping?: Record<string, unknown>
) {
  const { response } = await call(
    env,
    `/internal/slack-ingress/${encodeURIComponent(id)}/transition`,
    "POST",
    {
      leaseOwner,
      expectedState,
      state,
      ...(errorCode ? { errorCode } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(threadMapping ? { threadMapping } : {}),
    }
  );
  if (response.status === 409) return false;
  if (!response.ok) throw new Error(`Slack ingress transition failed (${response.status})`);
  return true;
}
export async function lookupSlackIngressThread(env: Env, channelId: string, threadTs: string) {
  const url = new URL("https://internal/internal/slack-ingress-thread");
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("threadTs", threadTs);
  const response = await signedControlPlaneFetch(
    env,
    { method: "GET", url: url.toString() },
    { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Slack ingress thread lookup failed (${response.status})`);
  return receiptEnvelopeSchema.parse(await response.json()).receipt;
}
