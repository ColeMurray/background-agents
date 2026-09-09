import { controlPlaneJsonGetProxy } from "@/lib/control-plane-json-proxy";

export const { GET } = controlPlaneJsonGetProxy(
  () => "/me/authorization",
  "current user authorization"
);
