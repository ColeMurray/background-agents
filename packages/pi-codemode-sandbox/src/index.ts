export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler;
