import { env } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { managedMcpConformance } from "../conformance/managed-mcp-conformance";

managedMcpConformance(async (run) => {
  await cleanD1Tables();
  await run(env.DB);
});
