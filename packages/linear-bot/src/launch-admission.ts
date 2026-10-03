/**
 * Launch admission for Linear delegations: resolves which Open-Inspect team a Linear
 * team is bound to, creates the session, and turns typed control-plane refusals into
 * user-facing guidance.
 */

import { createSessionResponseSchema } from "@open-inspect/shared/types/session-api";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { channelBindingResponseSchema } from "@open-inspect/shared/types/team-channel-bindings";
import { z } from "zod";
import type { Env } from "./types";
import { signedControlPlaneFetch } from "./internal-auth";
import { targetRequestFields, type SessionTarget } from "./target-resolution";

export type LinearTeamBinding =
  | { kind: "bound"; teamId: string | null }
  | { kind: "refused"; message: string };

/**
 * Resolve the Open-Inspect team bound to a Linear team. `teamId: null` means the
 * workspace's unbound-channel policy admits the delegation without a team.
 */
export async function resolveLinearTeamBinding(
  env: Env,
  linearTeamId: string,
  traceId: string
): Promise<LinearTeamBinding> {
  try {
    const bindingUrl = new URL(
      `https://internal/channel-bindings/linear/${encodeURIComponent(linearTeamId)}`
    );
    bindingUrl.searchParams.set("channel", `linear:${linearTeamId}`);
    const response = await signedControlPlaneFetch(env, {
      method: "GET",
      url: bindingUrl.toString(),
      traceId,
    });
    if (response.status === 404) {
      return {
        kind: "refused",
        message: `This Linear team is not bound. Ask a team lead or workspace administrator to bind Linear team \`${linearTeamId}\` in the team's Channels tab, then delegate again.`,
      };
    }
    if (!response.ok) throw new Error("Binding lookup failed");
    return {
      kind: "bound",
      teamId: channelBindingResponseSchema.parse(await response.json()).teamId,
    };
  } catch {
    return {
      kind: "refused",
      message:
        "Cannot resolve this Linear team's binding right now. No coding session was created; please retry.",
    };
  }
}

/**
 * Create a session via the control plane.
 */
export async function createSession(
  env: Env,
  target: SessionTarget,
  params: {
    title: string;
    model: string;
    harness: HarnessId | null;
    reasoningEffort?: string;
    actorUserId?: string;
    actorDisplayName?: string;
    actorEmail?: string;
    teamId: string | null;
  },
  traceId?: string
): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; body: string }> {
  const url = "https://internal/sessions";
  const body = JSON.stringify({
    ...targetRequestFields(target),
    title: params.title,
    model: params.model,
    // Absent harness resolves to the built-in default server-side; send it only
    // when configured so unset behavior stays byte-identical to today.
    ...(params.harness ? { harness: params.harness } : {}),
    reasoningEffort: params.reasoningEffort,
    actorDisplayName: params.actorDisplayName,
    actorEmail: params.actorEmail,
    teamId: params.teamId,
  });
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body,
    actor: params.actorUserId ? `linear:${params.actorUserId}` : undefined,
    traceId,
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    return { ok: false, status: response.status, body };
  }

  const result = createSessionResponseSchema.safeParse(await response.json().catch(() => null));
  if (!result.success) {
    return { ok: false, status: response.status, body: "invalid response" };
  }
  return { ok: true, sessionId: result.data.sessionId };
}

const sessionCreateRefusalSchema = z.object({
  code: z.string(),
  repository: z.string().optional(),
});

/** Explain a failed session creation, translating typed team-boundary refusals. */
export function describeSessionCreateFailure(
  failure: { status: number; body: string },
  targetLabel: string
): string {
  let rawRefusal: unknown;
  try {
    rawRefusal = JSON.parse(failure.body);
  } catch {
    rawRefusal = null;
  }
  const refusal = sessionCreateRefusalSchema.safeParse(rawRefusal);
  if (failure.status === 403 && refusal.success && refusal.data.code === "not_member") {
    return "The acting Linear user is not a member of the bound team. Add that user to the team before delegating again; automation-created requests use the installed app user. No coding session was created.";
  }
  if (
    failure.status === 409 &&
    refusal.success &&
    refusal.data.code === "target_team_missing_grant"
  ) {
    return `The bound team lacks the required repository grant for \`${refusal.data.repository ?? targetLabel}\`. Ask a team lead or workspace administrator to grant it, then delegate again. No coding session was created.`;
  }
  return `Failed to create a coding session.\n\n\`HTTP ${failure.status}: ${failure.body.slice(0, 200)}\``;
}
