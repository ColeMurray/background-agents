import { githubAutofixSessionCommandSchema } from "@open-inspect/shared";
import type { Logger } from "../../../logger";
import type { SessionAutofixService } from "../../services/autofix.service";

export interface AutofixHandler {
  handle(request: Request, log: Logger): Promise<Response>;
}

export function createAutofixHandler(service: SessionAutofixService): AutofixHandler {
  return {
    async handle(request: Request, log: Logger): Promise<Response> {
      try {
        const result = githubAutofixSessionCommandSchema.safeParse(await request.json());
        if (!result.success) {
          return Response.json({ error: "Invalid Autofix command" }, { status: 400 });
        }
        return Response.json(await service.handle(result.data));
      } catch (error) {
        log.error("handleAutofix error", {
          error: error instanceof Error ? error : String(error),
        });
        throw error;
      }
    },
  };
}
