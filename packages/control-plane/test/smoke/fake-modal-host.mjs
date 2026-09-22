/** Compose entrypoint; the preview imports the same owned protocol peer. */
import { startFakeModalServer } from "./fake-modal-server.mjs";

const server = await startFakeModalServer({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 9900),
  secret: process.env.MODAL_API_SECRET ?? "",
  reply: process.env.BRIDGE_REPLY,
  log(event, fields = {}) {
    console.log(JSON.stringify({ component: "fake-modal-host", event, ...fields }));
  },
});
console.log(JSON.stringify({ component: "fake-modal-host", event: "listening" }));
process.once("SIGINT", () => void server.close());
process.once("SIGTERM", () => void server.close());
