import { spawnSync } from "node:child_process";
import process from "node:process";

const guardFile = "scripts/check-provider-authority-boundary.mjs";
const obsoleteIdentifiers = ["NEXT_PUBLIC_GOOGLE_ENABLED", "GOOGLE_LOGIN_ENABLED"];
const result = spawnSync(
  "git",
  ["grep", "-n", "-E", obsoleteIdentifiers.join("|"), "--", ".", `:(exclude)${guardFile}`],
  { encoding: "utf8" }
);

if (result.status === 1) {
  process.exit(0);
}

if (result.status === 0) {
  process.stderr.write("Retired web-owned provider flags remain in tracked files:\n");
  process.stderr.write(`${result.stdout.trim()}\n`);
  process.exit(1);
}

process.stderr.write(
  `${result.stderr.trim() || "Unable to search tracked files for retired provider flags."}\n`
);
process.exit(result.status ?? 1);
