import { githubAutofixSessionCommandSchema } from "@open-inspect/shared";
import type { Logger } from "../../../logger";
import type { SessionAutofixService } from "../../services/autofix.service";

/** HTTP boundary for internal Autofix commands. */
export class AutofixHandler {
  constructor(private readonly service: SessionAutofixService) {}

  async handle(request: Request, log: Logger): Promise<Response> {
    try {
      const result = githubAutofixSessionCommandSchema.safeParse(await request.json());
      if (!result.success) {
        return Response.json({ error: "Invalid Autofix command" }, { status: 400 });
      }
      return Response.json(await this.service.handle(result.data));
    } catch (error) {
      log.error("handleAutofix error", {
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }
  }
}
