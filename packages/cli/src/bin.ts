#!/usr/bin/env node
import { runCli } from "./cli.js";
import { exitCodeFor } from "./errors.js";

runCli().catch((cause: unknown) => {
  process.exitCode = exitCodeFor(cause);
});
