const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * The overlay's test files must not expect the steering.
 *
 * The reference branch's copies assert the steering action, which the core
 * removed on purpose (C2). The core's copies are the ones that describe the
 * current design, so the overlay takes them.
 */
const root = process.cwd();
const run = (cmd) =>
  execSync(cmd, { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();

const files = process.argv.slice(2);
for (const file of files) {
  const coreHas = (() => {
    try {
      run(`git cat-file -e oi-core-end:'${file}'`);
      return true;
    } catch {
      return false;
    }
  })();
  if (!coreHas) {
    console.log(`  (skip) ${file}: the core does not have it`);
    continue;
  }
  const coreVersion = run(`git show oi-core-end:'${file}'`);
  const full = path.join(root, file);
  const current = fs.readFileSync(full, "utf8");
  if (coreVersion === current) {
    console.log(`  (same) ${file}`);
    continue;
  }
  fs.writeFileSync(full, coreVersion);
  console.log(`  took the core's ${file}`);
}
