import type { SpawnContext } from "@open-inspect/shared";
import type { SessionStatus } from "../../../types";
import type { SessionRepository } from "../../repository";
import type { SandboxRow, SessionRow } from "../../types";

export interface ChildSessionsHandlerDeps {
  repository: Pick<SessionRepository, "listParticipants" | "listArtifacts" | "listEvents">;
  getSession: () => SessionRow | null;
  getSandbox: () => SandboxRow | null;
  getPublicSessionId: (session: SessionRow) => string;
  broadcast: (message: {
    type: "child_session_update";
    childSessionId: string;
    status: SessionStatus;
    title: string | null;
  }) => void;
}

export interface ChildSessionsHandler {
  getSpawnContext: () => Response;
  getChildSummary: () => Response;
  childSessionUpdate: (request: Request) => Promise<Response>;
}

export function createChildSessionsHandler(deps: ChildSessionsHandlerDeps): ChildSessionsHandler {
  return {
    getSpawnContext(): Response {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      const participants = deps.repository.listParticipants();
      const owner = participants.find((participant) => participant.role === "owner");
      if (!owner) {
        return Response.json({ error: "No owner participant found" }, { status: 404 });
      }

      const context: SpawnContext = {
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        repoId: session.repo_id,
        model: session.model,
        reasoningEffort: session.reasoning_effort ?? null,
        baseBranch: session.base_branch,
        owner: {
          userId: owner.user_id,
          scmLogin: owner.scm_login,
          scmName: owner.scm_name,
          scmEmail: owner.scm_email,
          scmAccessTokenEncrypted: owner.scm_access_token_encrypted,
          scmRefreshTokenEncrypted: owner.scm_refresh_token_encrypted,
          scmTokenExpiresAt: owner.scm_token_expires_at,
        },
      };

      return Response.json(context);
    },

    getChildSummary(): Response {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      const sandbox = deps.getSandbox();
      const artifacts = deps.repository.listArtifacts();
      const allEvents = deps.repository.listEvents({ limit: 50 });

      // Filter out noisy event types and keep the most recent five.
      const filteredTypes = new Set(["token", "heartbeat", "step_start", "step_finish"]);
      const recentEvents = allEvents.filter((event) => !filteredTypes.has(event.type)).slice(0, 5);

      return Response.json({
        session: {
          id: deps.getPublicSessionId(session),
          title: session.title ?? "",
          status: session.status,
          repoOwner: session.repo_owner,
          repoName: session.repo_name,
          branchName: session.branch_name,
          model: session.model,
          createdAt: session.created_at,
          updatedAt: session.updated_at,
        },
        sandbox: sandbox ? { status: sandbox.status } : null,
        artifacts: artifacts.map((artifact) => ({
          type: artifact.type,
          url: artifact.url ?? "",
          metadata: artifact.metadata ? JSON.parse(artifact.metadata) : null,
        })),
        recentEvents: recentEvents.map((event) => ({
          type: event.type,
          data: JSON.parse(event.data),
          createdAt: event.created_at,
        })),
      });
    },

    async childSessionUpdate(request: Request): Promise<Response> {
      const body = (await request.json()) as {
        childSessionId: string;
        status: SessionStatus;
        title: string | null;
      };

      if (!body.childSessionId || !body.status) {
        return Response.json({ error: "childSessionId and status are required" }, { status: 400 });
      }

      deps.broadcast({
        type: "child_session_update",
        childSessionId: body.childSessionId,
        status: body.status,
        title: body.title ?? null,
      });

      return Response.json({ ok: true });
    },
  };
}
