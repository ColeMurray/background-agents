// Like `next dev`, the tracked CLI forks the worker that owns the HTTP listener.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

console.log(`owned-wrapper ${process.pid}`);
spawn(
  process.execPath,
  [fileURLToPath(new URL("./serving-next.mjs", import.meta.url)), ...process.argv.slice(2)],
  {
    stdio: "inherit",
  }
);
setInterval(() => {}, 1000);
