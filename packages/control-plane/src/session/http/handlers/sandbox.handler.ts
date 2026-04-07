import type { Logger } from "../../../logger";
import type { ParticipantRole, SandboxEvent } from "../../../types";
import type { SessionRepository } from "../../repository";
import type { SandboxRow, SessionRow } from "../../types";

interface AddParticipantRequest {
  userId: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  role?: string;
}

export interface SandboxHandlerDeps {
  repository: Pick<SessionRepository, "createParticipant">;
  processSandboxEvent: (event: SandboxEvent) => Promise<void>;
  getSandbox: () => SandboxRow | null;
  isValidSandboxToken: (token: string | null, sandbox: SandboxRow | null) => Promise<boolean>;
  getSession: () => SessionRow | null;
  generateId: () => string;
  now: () => number;
  getLog: () => Logger;
}

export interface SandboxHandler {
  sandboxEvent: (request: Request) => Promise<Response>;
  addParticipant: (request: Request) => Promise<Response>;
  verifySandboxToken: (request: Request) => Promise<Response>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createSandboxHandler(deps: SandboxHandlerDeps): SandboxHandler {
  return {
    async sandboxEvent(request: Request): Promise<Response> {
      const event = (await request.json()) as SandboxEvent;
      await deps.processSandboxEvent(event);
      return Response.json({ status: "ok" });
    },

    async addParticipant(request: Request): Promise<Response> {
      const body = (await request.json()) as AddParticipantRequest;

      const id = deps.generateId();
      const now = deps.now();

      deps.repository.createParticipant({
        id,
        userId: body.userId,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        role: (body.role ?? "member") as ParticipantRole,
        joinedAt: now,
      });

      return Response.json({ id, status: "added" });
    },

    async verifySandboxToken(request: Request): Promise<Response> {
      const body = (await request.json()) as { token: string };

      if (!body.token) {
        return jsonResponse({ valid: false, error: "Missing token" }, 400);
      }

      const sandbox = deps.getSandbox();
      if (!sandbox) {
        deps.getLog().warn("Sandbox token verification failed: no sandbox");
        return jsonResponse({ valid: false, error: "No sandbox" }, 404);
      }

      if (sandbox.status === "stopped" || sandbox.status === "stale") {
        deps.getLog().warn("Sandbox token verification failed: sandbox is stopped/stale", {
          status: sandbox.status,
        });
        return jsonResponse({ valid: false, error: "Sandbox stopped" }, 410);
      }

      const isTokenValid = await deps.isValidSandboxToken(body.token, sandbox);
      if (!isTokenValid) {
        deps.getLog().warn("Sandbox token verification failed: token mismatch");
        return jsonResponse({ valid: false, error: "Invalid token" }, 401);
      }

      deps.getLog().info("Sandbox token verified successfully");
      return jsonResponse({ valid: true }, 200);
    },
  };
}
