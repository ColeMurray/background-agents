import type { SessionSkillStore } from "../../../db/session-skills";
import type { PiRepositoryTools } from "../../../pi/repository-tools";
import {
  piRepositoryToolRequestSchema,
  piSessionContextRequestSchema,
  piSessionContextSchema,
} from "../../../pi/session-context-contract";
import type { MessageRepository } from "../../message-repository";
import type { PiCredentialService } from "../../pi-credential-service";
import type { SessionCoreRepository } from "../../session-core-repository";

interface PiBridgeHandlerOptions {
  sessions: Pick<SessionCoreRepository, "getSession" | "getSessionRepositories">;
  messages: Pick<MessageRepository, "getProcessingMessage">;
  credentials: Pick<PiCredentialService, "getOpenAIAccess">;
  skills: Pick<SessionSkillStore, "getSandboxInstallation">;
  repositories: Pick<PiRepositoryTools, "pin" | "restore" | "list" | "read">;
  getSessionId(): string;
}

/** Internal, binding-only bridge from PiSessionDO to SessionDO-owned capabilities. */
export class PiBridgeHandler {
  constructor(private readonly options: PiBridgeHandlerOptions) {}

  async credential(request: Request): Promise<Response> {
    if (!this.activeOperation(request)) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const rejected = request.headers.get("X-Pi-Rejected-Credential-Version");
    const rejectedCredentialVersion = rejected ? Number(rejected) : undefined;
    if (
      rejectedCredentialVersion !== undefined &&
      (!Number.isSafeInteger(rejectedCredentialVersion) || rejectedCredentialVersion <= 0)
    ) {
      return Response.json({ error: "Invalid rejected credential version" }, { status: 400 });
    }
    try {
      const access = await this.options.credentials.getOpenAIAccess(
        this.options.getSessionId(),
        rejectedCredentialVersion
      );
      return Response.json(
        {
          access_token: access.accessToken,
          expires_in: Math.max(1, Math.floor((access.expiresAt - Date.now()) / 1_000)),
          credential_version: access.credentialVersion,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch {
      return Response.json({ error: "OpenAI provider account unavailable" }, { status: 409 });
    }
  }

  async context(request: Request): Promise<Response> {
    if (this.options.sessions.getSession()?.harness !== "pi") {
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    }
    const parsed = piSessionContextRequestSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return Response.json({ error: "Invalid Pi session context request" }, { status: 400 });
    }
    const sessionId = this.options.getSessionId();
    const [repositories, skills] = await Promise.all([
      parsed.data.repositoryPins
        ? this.options.repositories.restore(parsed.data.repositoryPins)
        : this.options.repositories.pin(),
      this.options.skills.getSandboxInstallation(sessionId),
    ]);
    const context = piSessionContextSchema.parse({
      repositories,
      skills,
    });
    return Response.json(context, { headers: { "Cache-Control": "no-store" } });
  }

  async repositoryTool(request: Request): Promise<Response> {
    if (!this.activeOperation(request)) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const parsed = piRepositoryToolRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid Pi repository tool request" }, { status: 400 });
    }
    try {
      const result =
        parsed.data.tool === "repository_list"
          ? await this.options.repositories.list(parsed.data.arguments)
          : await this.options.repositories.read(parsed.data.arguments);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Repository tool failed" },
        { status: 400 }
      );
    }
  }

  private activeOperation(request: Request): boolean {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    return (
      this.options.sessions.getSession()?.harness === "pi" &&
      !!operationId &&
      this.options.messages.getProcessingMessage()?.id === operationId
    );
  }
}
