import { SessionInternalPaths } from "../contracts";
import {
  createSessionInternalRoutes,
  type SessionInternalRoute,
  type SessionInternalRouteHandler,
  type SessionInternalRouteHandlers,
} from "./routes";

export interface OverlaySessionInternalRouteHandlers extends SessionInternalRouteHandlers {
  piExternalActionPrepare: SessionInternalRouteHandler;
  piExternalActionStatus: SessionInternalRouteHandler;
  piExternalActionExecute: SessionInternalRouteHandler;
  crossSessionMessage: SessionInternalRouteHandler;
  crossSessionAuthorize: SessionInternalRouteHandler;
  mcpPinGrant: SessionInternalRouteHandler;
  crossSessionInbound: SessionInternalRouteHandler;
  externalActionStatus: SessionInternalRouteHandler;
  externalActionPending: SessionInternalRouteHandler;
  externalActionDecision: SessionInternalRouteHandler;
}

/** Add the Compound-only routes to the upstream-compatible session router. */
export function createOverlaySessionInternalRoutes(
  handlers: OverlaySessionInternalRouteHandlers
): SessionInternalRoute[] {
  return [
    ...createSessionInternalRoutes(handlers),
    {
      method: "POST",
      path: SessionInternalPaths.piExternalActionPrepare,
      handler: handlers.piExternalActionPrepare,
    },
    {
      method: "GET",
      path: SessionInternalPaths.piExternalActionStatus,
      handler: handlers.piExternalActionStatus,
    },
    {
      method: "POST",
      path: SessionInternalPaths.piExternalActionExecute,
      handler: handlers.piExternalActionExecute,
    },
    {
      method: "GET",
      path: SessionInternalPaths.externalActionStatus,
      handler: handlers.externalActionStatus,
    },
    { method: "POST", path: SessionInternalPaths.mcpPinGrant, handler: handlers.mcpPinGrant },
    {
      method: "POST",
      path: SessionInternalPaths.crossSessionAuthorize,
      handler: handlers.crossSessionAuthorize,
    },
    {
      method: "POST",
      path: SessionInternalPaths.crossSessionMessage,
      handler: handlers.crossSessionMessage,
    },
    {
      method: "POST",
      path: SessionInternalPaths.crossSessionInbound,
      handler: handlers.crossSessionInbound,
    },
    {
      method: "GET",
      path: SessionInternalPaths.externalActionPending,
      handler: handlers.externalActionPending,
    },
    {
      method: "POST",
      path: SessionInternalPaths.externalActionDecision,
      handler: handlers.externalActionDecision,
    },
  ];
}
