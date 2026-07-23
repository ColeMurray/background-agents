import { Hono } from "hono";
import { callbacksRouter } from "./callbacks";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { interactionRoutes } from "./routes/interactions";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.route("/", healthRoutes);
app.route("/", eventRoutes);
app.route("/", interactionRoutes);
app.route("/callbacks", callbacksRouter);

export default app;
