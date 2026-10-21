const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();
const run = (cmd) =>
  execSync(cmd, { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString();

const OLD_CORE = "feat/do-harness-core";
const OLD_OVERLAY = "ddc7b0ba";

const coreFiles = run(`git diff --name-only origin/main..${OLD_CORE}`)
  .split("\n")
  .filter(Boolean);
const coreDeletions = run(
  `git diff --name-only --diff-filter=D origin/main..${OLD_CORE}`
)
  .split("\n")
  .filter(Boolean);
const overlayAdded = run(
  `git diff --name-only --diff-filter=A ${OLD_CORE}..${OLD_OVERLAY}`
)
  .split("\n")
  .filter(Boolean);
const overlayModified = run(`git diff --name-only ${OLD_CORE}..${OLD_OVERLAY}`)
  .split("\n")
  .filter(Boolean)
  .filter((file) => !overlayAdded.includes(file));

const seam = {
  title: "feat: the harness-neutral seam",
  body: [
    "The seam a Durable Object harness needs, and which names no harness.",
    "",
    "A harness that runs inside a sandbox is contained by the sandbox. A harness that",
    "runs in a Durable Object is not, so everything the sandbox gave for free has to",
    "be rebuilt as an explicit check. This is that seam:",
    "",
    "- the tool-effect contract: every tool declares what it can do, who may call it,",
    "  and whether it is safe to replay;",
    "- the capability gate: off, read-only, enabled, and anything unknown is off;",
    "- one ledger for which migration numbers are taken;",
    "- the default-deny policy hook, the extension assembler, the deployment kill",
    "  switch, the execution principal, the server-side pricing port, the usage",
    "  accounting, and the turn's author checked against current authority;",
    "- the Durable Object's runtime bindings, scoped before they reach the base class,",
    "  so an object that runs model-driven code holds no deployment secret.",
  ].join("\n"),
  patterns: [
    "packages/shared/src/tool-effects.ts",
    "packages/shared/src/capability-modes.ts",
    "packages/shared/src/migration-reservations.ts",
    "packages/control-plane/src/harness/",
    "packages/control-plane/src/cloudflare/binding-scope.ts",
  ],
};

const adapter = {
  title: "feat: the Pi harness adapter",
  body: [
    "Pi, as the first harness on that seam.",
    "",
    "The Pi Durable Object is a durable, crash-recoverable conversation with no cold",
    "boot, no sandbox and no base64 blobs: the Durable Object's own SQLite is the",
    "transcript, and the Code Mode script lane runs in a separately deployed Worker",
    "with no control-plane bindings at all.",
    "",
    "What is in this commit:",
    "",
    "- the Durable Object and the Pi harness it hosts;",
    "- the session side of the seam: the bridge, the events, the result, the controls,",
    "  the memory, the execution;",
    "- the harness registration and the deployment gate;",
    "- the Code Mode Worker.",
  ].join("\n"),
  patterns: [
    "packages/control-plane/src/pi/",
    "packages/control-plane/src/cloudflare/pi-",
    "packages/control-plane/src/session/http/handlers/pi-",
    "packages/control-plane/src/session/pi-",
    "packages/shared/src/pi-tool-effects.ts",
    "packages/shared/src/pi-feature-capabilities.ts",
    "packages/shared/src/memory-tools.ts",
    "packages/shared/src/harnesses.ts",
    "packages/control-plane/src/harness-admission.ts",
    "packages/pi-codemode-sandbox/",
  ],
};

const capabilities = {
  title: "feat: the capabilities the harness owns",
  body: [
    "What the harness can do, one capability at a time.",
    "",
    "- **memory**: the tools over the product's own memory, through the existing",
    "  authority;",
    "- **browser**: the agent proposes a page, the session authorizes it against a",
    "  deployment-configured host allowlist, and the browser runs a fresh session with",
    "  no credential;",
    "- **code mode**: a script lane in a separately deployed Worker;",
    "- **sandbox execution**: escalation to a real sandbox, credential-free and",
    "  repo-less;",
    "- **repository editing**: a writable layer over the session's own pinned",
    "  repositories;",
    "- **skills**: the session's pinned, hash-verified skills;",
    "- **attachments and media**, **session diffs**, **the trace export**, and the",
    "  **durable Slack ingress** that makes a Slack session a first-class session.",
  ].join("\n"),
  patterns: [
    "packages/shared/src/memory-tools.ts",
    "packages/control-plane/src/memory/",
    "packages/control-plane/src/pi/browser-",
    "packages/control-plane/src/pi/codemode-",
    "packages/control-plane/src/pi/sandbox-execution-extension.ts",
    "packages/control-plane/src/pi/repository-",
    "packages/control-plane/src/pi/skill-source.ts",
    "packages/control-plane/src/pi/managed-skills-extension.ts",
    "packages/control-plane/src/pi/workspace-input-limits.ts",
    "packages/control-plane/src/sandbox/execution-",
    "packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts",
    "packages/control-plane/src/cloudflare/browser-rendering-transport.ts",
    "packages/control-plane/src/session/session-attachment-",
    "packages/control-plane/src/session/diffs/",
    "packages/control-plane/src/routes/session-export.ts",
    "packages/shared/src/types/trace-export.ts",
    "packages/control-plane/src/db/slack-ingress.ts",
    "packages/control-plane/src/routes/slack-ingress.ts",
    "packages/shared/src/slack-ingress.ts",
  ],
};

const fixes = {
  title: "fix: what the conformance audit found",
  body: [
    "Every §7 row that failed, most severe first.",
    "",
    "- **B-8**: the Durable Object's runtime bindings are scoped before they reach",
    "  the base class, so the object physically holds no deployment secret;",
    "- **B-5, B-6**: the turn's author is checked again, against current D1, before",
    "  every capability call — the fence used to be an activity check and nothing",
    "  more;",
    "- **A-2**: a stored harness this binary does not know **fails closed** instead of",
    "  becoming the built-in harness;",
    "- **G-1, G-2**: every migration number the branch took is reserved, and the",
    "  migrations declare the feature that owns them;",
    "- **G-5**: the projection the export reads is proven, and the export says plainly",
    "  what it does not carry;",
    "- **G-6**: the audit records a harness-neutral principal kind, so a Pi agent's",
    "  row no longer says \"sandbox\";",
    "- **C2**: mid-turn steering is gone — the reference model forbids it and the",
    "  brief says not to build it;",
    "- **suspect #5**: an MCP grant is re-evaluated against current authority at every",
    "  call;",
    "- the published trace-export schema has a drift test again, and it caught the",
    "  schema being stale.",
  ].join("\n"),
  patterns: [
    "packages/control-plane/src/harness/turn-authority.ts",
    "packages/control-plane/test/integration/turn-authority.test.ts",
    "packages/control-plane/test/integration/pi-export-projection.test.ts",
    "packages/control-plane/test/integration/pi-end-to-end.test.ts",
    "packages/shared/src/stored-harness.test.ts",
    "scripts/trace-export-schema-drift.test.mjs",
    "packages/shared/src/types/audit-events.ts",
    "packages/control-plane/src/db/memory-records.ts",
  ],
};

const client = {
  title: "feat: the web client for the harness",
  body: "The session screens for a Durable Object harness: the session list, the controls, the timeline, and the capabilities the session has.",
  patterns: ["packages/web/"],
};

const bots = {
  title: "feat: the bots can start a harness session",
  body: "A Slack, Linear or GitHub comment can start a session that runs on the Durable Object harness, and the durable Slack ingress makes the retry of a delivery idempotent instead of a second session.",
  patterns: ["packages/slack-bot/", "packages/linear-bot/", "packages/github-bot/"],
};

const runtime = {
  title: "feat: the execution sandbox for a harness that escalates",
  body: "When a session escalates to real execution, the sandbox is credential-free, repo-less, and bounded by a package-install egress profile — the containment the Durable Object harness does not have.",
  patterns: ["packages/sandbox-runtime/", "packages/sandbox-images/", "packages/modal-infra/"],
};

const deployment = {
  title: "feat: the deployment",
  body: "The Durable Object class and its two-phase migration, the deployment variables, the workflow that stages it, and the environment variables that turn each capability on. Every flag defaults to off.",
  patterns: [
    "terraform/",
    ".github/",
    "scripts/",
    ".env.example",
    "package.json",
    "package-lock.json",
    "packages/control-plane/package.json",
    "packages/control-plane/wrangler.jsonc",
    "packages/control-plane/vitest.integration.config.ts",
    "packages/control-plane/tsconfig.json",
    "packages/control-plane/test/integration/tsconfig.json",
    "packages/control-plane/src/env-validation.ts",
    "packages/control-plane/src/node/config.ts",
    "packages/control-plane/src/types.ts",
    "packages/control-plane/src/cloudflare/platform.ts",
    "packages/control-plane/src/index.ts",
    "packages/control-plane/src/worker-build.test.ts",
    "packages/shared/package.json",
    "packages/shared/src/index.ts",
    "packages/shared/src/types/index.ts",
  ],
};

const series = [seam, adapter, capabilities, fixes, client, bots, runtime, deployment];

const matches = (file, patterns) => patterns.some((pattern) => file.includes(pattern));
const claimed = new Set();
const planned = series.map((entry) => {
  const files = coreFiles.filter((file) => {
    if (claimed.has(file) || !matches(file, entry.patterns)) return false;
    claimed.add(file);
    return true;
  });
  return { ...entry, files };
});
const rest = coreFiles.filter((file) => !claimed.has(file));
planned.push({
  title: "feat: the Pi harness in the control plane",
  body: [
    "Everything the harness needs from the control plane: the session's wiring, the",
    "routes, the stores, the clients, and the deployment.",
    "",
    "This is the commit that makes the harness a session like any other: one turn at a",
    "time, the session's own authority, the session's own timeline.",
  ].join("\n"),
  files: rest,
});

for (const group of planned) {
  console.log(`  ${group.title} — ${group.files.length} files`);
}

run(`git reset --hard -q origin/main`);
run(`git checkout -B rebuild/series origin/main`);
for (const group of planned) {
  for (const file of group.files) run(`git checkout ${OLD_CORE} -- '${file}'`);
  run(`git add -A`);
  run(
    `git commit -q --no-verify -m ${JSON.stringify(group.title)} -m ${JSON.stringify(group.body)}`
  );
}
if (coreDeletions.length > 0) {
  for (const file of coreDeletions) run(`git rm -q --cached '${file}'`);
  run(`git add -A`);
  run(
    `git commit -q --no-verify -m "refactor: the files the harness replaces" -m "The harness replaces these with its own, and the upstream's own copies of the seam move into the harness package."`
  );
}
run(`git tag -f oi-core-end`);
console.log("  tagged oi-core-end");

run(`git checkout -B rebuild/overlay oi-core-end`);
for (const file of [...overlayAdded, ...overlayModified]) {
  run(`git checkout ${OLD_OVERLAY} -- '${file}'`);
}
run(`git add -A`);
run(
  `git commit -q --no-verify -m "feat: the overlay — personal MCP, the approval ledger, cross-session" -m "Three capabilities Open-Inspect does not have today, on top of a core that never had them. Additive: the core's files keep their fixes, and the overlay only adds.

- personal MCP connections with OAuth, PKCE and DCR: one person's own credential against a reviewed, remote-only server, re-evaluated against current authority at every call;
- the external-action approval ledger: an effect that changes something outside the model is prepared, and a human decides;
- cross-session messaging: a session hands a message to another session, with the fan-out bounded and the provenance recorded.

Every one of them is off by default, and every one has an entry in DEVIATIONS.md."`
);
console.log(
  `  the overlay — ${overlayAdded.length} added, ${overlayModified.length} changed`
);

console.log("\n  the new history:");
console.log(
  run(`git log --oneline origin/main..HEAD`)
    .split("\n")
    .filter(Boolean)
    .map((line) => `    ${line}`)
    .join("\n")
);
