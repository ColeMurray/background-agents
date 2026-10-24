import { SessionInternalPaths } from "../contracts";
import {
  createSessionInternalRoutes,
  type SessionInternalRoute,
  type SessionInternalRouteHandler,
  type SessionInternalRouteHandlers,
} from "./routes";

export interface OverlaySessionInternalRouteHandlers {
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
  piMcpList: SessionInternalRouteHandler;
  piMcpRead: SessionInternalRouteHandler;
}

/** Add the Optional routes to the upstream-compatible session router. */
export function createOverlaySessionInternalRoutes(
  handlers: SessionInternalRouteHandlers,
  overlay: OverlaySessionInternalRouteHandlers
): SessionInternalRoute[] {
  const coreRoutes = createSessionInternalRoutes(handlers).map((route) => {
    if (route.path === SessionInternalPaths.piMcpList) {
      return { ...route, handler: overlay.piMcpList };
    }
    if (route.path === SessionInternalPaths.piMcpRead) {
      return { ...route, handler: overlay.piMcpRead };
    }
    return route;
  });
  return [
    ...coreRoutes,
    {
      method: "POST",
      path: SessionInternalPaths.piExternalActionPrepare,
      handler: overlay.piExternalActionPrepare,
    },
    {
      method: "GET",
      path: SessionInternalPaths.piExternalActionStatus,
      handler: overlay.piExternalActionStatus,
    },
    {
      method: "POST",
      path: SessionInternalPaths.piExternalActionExecute,
      handler: overlay.piExternalActionExecute,
    },
    {
      method: "GET",
      path: SessionInternalPaths.externalActionStatus,
      handler: overlay.externalActionStatus,
    },
    { method: "POST", path: SessionInternalPaths.mcpPinGrant, handler: overlay.mcpPinGrant },
    {
      method: "POST",
      path: SessionInternalPaths.crossSessionAuthorize,
      handler: overlay.crossSessionAuthorize,
    },
    {
      method: "POST",
      path: SessionInternalPaths.crossSessionMessage,
      handler: overlay.crossSessionMessage,
    },
    {
      method: "POST",
      path: SessionInternalPaths.crossSessionInbound,
      handler: overlay.crossSessionInbound,
    },
    {
      method: "GET",
      path: SessionInternalPaths.externalActionPending,
      handler: overlay.externalActionPending,
    },
    {
      method: "POST",
      path: SessionInternalPaths.externalActionDecision,
      handler: overlay.externalActionDecision,
    },
  ];
}

/** Bind overlay handlers once so the core route table keeps its native shape. */
export function createOverlaySessionInternalRouteBuilder(
  overlay: OverlaySessionInternalRouteHandlers
): (handlers: SessionInternalRouteHandlers) => SessionInternalRoute[] {
  return (handlers) => createOverlaySessionInternalRoutes(handlers, overlay);
}
