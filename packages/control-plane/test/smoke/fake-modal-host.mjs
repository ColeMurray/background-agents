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
// A failed close is logged instead of escaping as an unhandled rejection. It can leave the listener
// open, so exit explicitly rather than wait for an event loop that never drains.
const stop = (signal) => {
  server.close().catch((error) => {
    console.error(
      JSON.stringify({
        component: "fake-modal-host",
        event: "close_failed",
        signal,
        error: String(error),
      })
    );
    process.exit(1);
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
