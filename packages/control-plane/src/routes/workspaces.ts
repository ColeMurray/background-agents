import type { ListWorkspacesResponse } from "@open-inspect/shared";
import { WorkspaceStore } from "../db/workspaces";
import type { Env } from "../types";
import { json, parsePattern, type RequestContext, type Route } from "./shared";

async function handleListWorkspaces(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const store = new WorkspaceStore(env.DB);
  const response: ListWorkspacesResponse = {
    workspaces: await store.listWorkspaces(),
  };
  return json(response);
}

export const workspaceRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/workspaces"),
    handler: handleListWorkspaces,
  },
];
