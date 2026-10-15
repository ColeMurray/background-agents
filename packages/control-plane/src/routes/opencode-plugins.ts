import { Hono } from "hono";
import {
  opencodePluginInputSchema,
  opencodePluginUpdateSchema,
} from "@open-inspect/shared/types/opencode-plugins";
import { OpencodePluginStore, OpencodePluginConflictError } from "../db/opencode-plugins";
import { isUniqueConstraintError } from "../db/errors";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { parseBody } from "./body";
import {
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  error,
  json,
  requirePermission,
  type RequestContext,
} from "./shared";

const read = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("opencode_plugins.read"),
});
const manage = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("opencode_plugins.manage"),
});
export const opencodePluginRoutes = new Hono<ControlPlaneHonoEnv>();

opencodePluginRoutes.get("/opencode-plugins", read, (c) =>
  dispatch(c, async (_request, _env, _params, ctx) => {
    if (!ctx.db) return error("Database not configured", 503);
    return json(await new OpencodePluginStore(ctx.db).list());
  })
);

async function save(request: Request, ctx: RequestContext, id?: string): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  const store = new OpencodePluginStore(ctx.db);
  try {
    if (id) {
      const input = await parseBody(
        request,
        opencodePluginUpdateSchema,
        "Invalid OpenCode plugin update"
      );
      if (input instanceof Response) return input;
      const plugin = await store.update(id, input);
      return plugin ? json(plugin) : error("OpenCode plugin not found", 404);
    }
    const input = await parseBody(
      request,
      opencodePluginInputSchema,
      "Invalid OpenCode plugin configuration"
    );
    if (input instanceof Response) return input;
    return json(await store.create(input), 201);
  } catch (err) {
    if (err instanceof OpencodePluginConflictError) return error(err.message, 409);
    if (isUniqueConstraintError(err)) return error("This plugin is already configured", 409);
    throw err;
  }
}
opencodePluginRoutes.post("/opencode-plugins", manage, (c) =>
  dispatch(c, (request, _env, _params, ctx) => save(request, ctx))
);
opencodePluginRoutes.put("/opencode-plugins/:id", manage, (c) =>
  dispatch(c, (request, _env, params: { id: string }, ctx) => save(request, ctx, params.id))
);
opencodePluginRoutes.delete("/opencode-plugins/:id", manage, (c) =>
  dispatch(c, async (_request, _env, params: { id: string }, ctx) => {
    if (!ctx.db) return error("Database not configured", 503);
    return (await new OpencodePluginStore(ctx.db).delete(params.id))
      ? json({ ok: true })
      : error("OpenCode plugin not found", 404);
  })
);
