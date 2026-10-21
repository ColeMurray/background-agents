import { controlPlaneJsonGetProxy } from "@/lib/control-plane-json-proxy";

export const { GET } = controlPlaneJsonGetProxy(() => "/capabilities", "deployment capabilities");
