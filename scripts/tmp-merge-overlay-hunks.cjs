const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * The overlay, merged hunk by hunk.
 *
 * The brief's rule: **the overlay changes no core file.** So for a file the
 * two layers share, the overlay's version is the *core's* file plus the
 * overlay's *additions* — recovered from the reference branch by keeping only
 * the hunks that speak the overlay's vocabulary. A hunk that touches the
 * core's own fixes (the steering, the neutral execution principal, the
 * seam's module names) is not an addition, and is dropped.
 */

const root = process.cwd();
const run = (cmd, options = {}) =>
  execSync(cmd, {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).toString();

const CORE = "oi-core-end";
const ORACLE = "feat/pi-go-live-integration-v2";

const OVERLAY_VOCABULARY =
  /\b(Mcp|MCP|mcp)[A-Za-z]*|external[-_ ]?[Aa]ction|ExternalAction|cross[-_ ]?[Ss]ession|CrossSession|personalMcp|PI_EXTERNAL_ACTIONS|PI_CROSS_SESSION|MCP_CONNECTION|MCP_CONNECTIONS_ENABLED|MCP_OAUTH_ENCRYPTION_KEY/;

const shared = run(`git diff --name-only ${CORE}..HEAD`)
  .split("\n")
  .filter(Boolean)
  .filter((file) => {
    try {
      run(`git cat-file -e ${CORE}:'${file}'`);
      return true;
    } catch {
      return false;
    }
  });

function splitHunks(diff) {
  const lines = diff.split("\n");
  const header = [];
  const out = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) out.push(current);
      current = [line];
      continue;
    }
    if (current) current.push(line);
    else header.push(line);
  }
  if (current) out.push(current);
  return { header, hunks: out };
}

let applied = 0;
let untouched = 0;
const rejected = [];

for (const file of shared) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;

  // The core's file is the base the overlay adds to.
  const coreVersion = run(`git show ${CORE}:'${file}'`);
  fs.writeFileSync(full, coreVersion);

  let diff;
  try {
    diff = run(`git diff --no-color ${CORE} ${ORACLE} -- '${file}'`);
  } catch {
    continue;
  }
  if (!diff.trim()) {
    untouched += 1;
    continue;
  }

  const { header, hunks } = splitHunks(diff);
  const kept = hunks.filter((hunk) =>
    hunk.some((line) => line.startsWith("+") && OVERLAY_VOCABULARY.test(line))
  );
  if (kept.length === 0) {
    untouched += 1;
    continue;
  }

  const patchFile = path.join(root, ".overlay-hunk.patch");
  fs.writeFileSync(patchFile, [...header, ...kept.flat()].join("\n"));
  try {
    run(`patch -p1 --forward --batch --fuzz=3 < .overlay-hunk.patch`);
    applied += 1;
  } catch {
    rejected.push(file);
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

console.log(`  merged ${applied} shared files, ${untouched} needed no overlay change`);
if (rejected.length > 0) {
  console.log(`  ${rejected.length} files could not be merged hunk by hunk:`);
  for (const file of rejected) console.log(`    ${file}`);
}
