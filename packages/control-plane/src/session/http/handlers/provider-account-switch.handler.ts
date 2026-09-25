import {
  providerAccountSwitchRequestSchema,
  providerAccountResumeRequestSchema,
} from "@open-inspect/shared/types/provider-account-switch";
import { subscriptionProviderIdSchema } from "@open-inspect/shared/types/provider-accounts";
import {
  ProviderSwitchError,
  type ProviderAccountSwitchCoordinator,
} from "../../provider-account-switch";
import { AuthorizationError } from "../../../authorization/service";

/** Independently authenticate the forwarded browser cookie and current grants. */
export class ProviderAccountSwitchHandler {
  constructor(
    private readonly coordinator: ProviderAccountSwitchCoordinator,
    private readonly authorize: (request: Request, mutation: boolean) => Promise<string>
  ) {}
  async handle(request: Request, action: "read" | "switch" | "resume"): Promise<Response> {
    try {
      const actorId = await this.authorize(request, action !== "read");
      if (action === "switch") {
        const provider = subscriptionProviderIdSchema.safeParse(
          new URL(request.url).searchParams.get("provider")
        );
        const body = providerAccountSwitchRequestSchema.safeParse(
          await request.json().catch(() => null)
        );
        if (!provider.success || !body.success)
          return Response.json({ error: "Invalid switch request" }, { status: 400 });
        await this.coordinator.start(provider.data, body.data, actorId);
      } else if (action === "resume") {
        const body = providerAccountResumeRequestSchema.safeParse(
          await request.json().catch(() => null)
        );
        if (!body.success)
          return Response.json({ error: "Invalid resume request" }, { status: 400 });
        await this.coordinator.resume(body.data.operationId, body.data.bindingRevision, actorId);
      }
      return Response.json(await this.coordinator.snapshot(), {
        status: action === "switch" ? 202 : 200,
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof AuthorizationError)
        return Response.json({ error: error.code }, { status: error.status });
      if (error instanceof ProviderSwitchError)
        return Response.json({ error: error.message }, { status: 409 });
      return Response.json({ error: "Provider account recovery unavailable" }, { status: 503 });
    }
  }
}
