/** Run actual TS requests through Python receiver + runtime consumers, without providers. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "open-inspect-launch-contract-"));
const env = { ...process.env, LAUNCH_CONTRACT_OUTPUT: join(scratch, "requests.json") };
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
try {
  run("npm", ["run", "build", "-w", "@open-inspect/shared"], root);
  run(
    "npm",
    [
      "run",
      "test",
      "-w",
      "@open-inspect/control-plane",
      "--",
      "src/sandbox/launch-contract.test.ts",
    ],
    root
  );
  run(
    "uv",
    [
      "run",
      "--frozen",
      "--extra",
      "dev",
      "--python",
      "3.12",
      "pytest",
      "tests/test_launch_contract.py",
      "-q",
    ],
    join(root, "packages/modal-infra")
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
