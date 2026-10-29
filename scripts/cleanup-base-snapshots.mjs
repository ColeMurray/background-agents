import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createSnapshotClient } from "./lib/base-snapshot-client.ts";
import { cleanup, CleanupDeletionError, validatePolicy } from "./lib/base-snapshot-retention.ts";

async function main() {
  const { values } = parseArgs({
    options: { policy: { type: "string" }, apply: { type: "boolean", default: false } },
  });
  if (!values.policy)
    throw new Error(
      "Usage: npm run --silent sandbox:cleanup-base-snapshots -- --policy FILE [--apply]"
    );
  const policy = validatePolicy(JSON.parse(await readFile(values.policy, "utf8")));
  const client = createSnapshotClient(policy, process.env);
  console.log(JSON.stringify(await cleanup(client, policy, { apply: values.apply }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Record what a failed batch already deleted and what remains.
    if (error instanceof CleanupDeletionError) console.log(JSON.stringify(error.report, null, 2));
    console.error(error.message);
    process.exitCode = 1;
  });
}
