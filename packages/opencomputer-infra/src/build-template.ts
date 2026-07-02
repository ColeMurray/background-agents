import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Image, Snapshots } from "@opencomputer/sdk/node";

const OPENCODE_VERSION = "1.14.41";
const CODE_SERVER_VERSION = "4.109.5";
const PYTHON_VERSION = "3.12";
const AGENT_BROWSER_VERSION = "0.21.2";
const TTYD_VERSION = "1.7.7";
const TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55";
const SANDBOX_HOME = "/home/sandbox";
const SANDBOX_APP_DIR = `${SANDBOX_HOME}/app`;
const NPM_PREFIX = `${SANDBOX_HOME}/.npm-global`;
const NPM_CACHE = `${SANDBOX_HOME}/.npm-cache`;
const USER_BIN = `${SANDBOX_HOME}/.local/bin`;
const BUN_INSTALL_DIR = `${SANDBOX_HOME}/.bun`;
const PYTHON_VENV = `${SANDBOX_HOME}/.venv`;
const UV_CACHE = `${SANDBOX_HOME}/.cache/uv`;
const UV_PYTHON_INSTALL_DIR = `${SANDBOX_HOME}/.local/share/uv/python`;
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const OPENSANDBOX_PROXY_CA = "/usr/local/share/ca-certificates/opensandbox-proxy.crt";
const LOCAL_NO_PROXY = "localhost,127.0.0.1,::1";
const HOSTS_BOOTSTRAP =
  "grep -Eq '^[[:space:]]*127\\.0\\.0\\.1[[:space:]].*\\blocalhost\\b' /etc/hosts || " +
  "printf '%s\\n' '127.0.0.1 localhost' | sudo tee -a /etc/hosts >/dev/null; " +
  "grep -Eq '^[[:space:]]*::1[[:space:]].*\\blocalhost\\b' /etc/hosts || " +
  "printf '%s\\n' '::1 localhost ip6-localhost ip6-loopback' | sudo tee -a /etc/hosts >/dev/null";
const DNS_BOOTSTRAP =
  "sudo rm -f /etc/resolv.conf; " +
  "printf '%s\\n' 'nameserver 8.8.8.8' 'nameserver 1.1.1.1' | sudo tee /etc/resolv.conf >/dev/null";

interface BuildOptions {
  apiUrl: string;
  apiKey: string;
  snapshotName: string;
  repoRoot: string;
  builderMemoryMb: number;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const options = resolveOptions(process.argv.slice(2));
  const image = buildImage(options);

  if (options.dryRun) {
    console.log(JSON.stringify(image.toJSON(), null, 2));
    console.log(`cacheKey=${image.cacheKey()}`);
    return;
  }

  if (!options.apiKey) {
    throw new Error("OPENCOMPUTER_API_KEY is required to build an OpenComputer snapshot");
  }

  console.log(`Building OpenComputer snapshot ${options.snapshotName}`);
  console.log(`API: ${options.apiUrl}`);
  console.log(`Runtime source: ${join(options.repoRoot, "packages/sandbox-runtime")}`);
  console.log(`Image cache key: ${image.cacheKey()}`);

  const snapshots = new Snapshots({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
  });
  const result = await snapshots.create({
    name: options.snapshotName,
    image,
    onBuildLogs: (log) => console.log(`build: ${log}`),
  });
  console.log(JSON.stringify(result, null, 2));
}

function resolveOptions(args: string[]): BuildOptions {
  const flags = new Set(args);
  const repoRoot = process.env.OPENINSPECT_REPO_ROOT || getRepoRoot();
  const snapshotName = process.env.OPENCOMPUTER_TEMPLATE || "openinspect-runtime";
  const builderMemoryMb = parsePositiveInt(process.env.OPENCOMPUTER_BUILDER_MEMORY_MB, 8192);

  return {
    apiUrl: normalizeApiUrl(process.env.OPENCOMPUTER_API_URL || "https://app.opencomputer.dev/api"),
    apiKey: process.env.OPENCOMPUTER_API_KEY || "",
    snapshotName,
    repoRoot,
    builderMemoryMb,
    dryRun: flags.has("--dry-run") || flags.has("--print-manifest"),
  };
}

function getRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function normalizeApiUrl(value: string): string {
  const base = value.replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildImage(options: Pick<BuildOptions, "repoRoot" | "builderMemoryMb">): Image {
  const runtimeDir = join(options.repoRoot, "packages/sandbox-runtime/src/sandbox_runtime");
  if (!existsSync(runtimeDir)) {
    throw new Error(`Missing sandbox runtime directory: ${runtimeDir}`);
  }

  let image = Image.base()
    .aptInstall([
      "bash",
      "git",
      "curl",
      "build-essential",
      "ca-certificates",
      "gnupg",
      "openssh-client",
      "jq",
      "unzip",
      "libnss3",
      "libnspr4",
      "libatk1.0-0",
      "libatk-bridge2.0-0",
      "libcups2",
      "libdrm2",
      "libxkbcommon0",
      "libxcomposite1",
      "libxdamage1",
      "libxfixes3",
      "libxrandr2",
      "libgbm1",
      "libasound2",
      "libpango-1.0-0",
      "libcairo2",
      "ffmpeg",
      "procps",
    ])
    .pipInstall(["uv"])
    .runCommands(
      `mkdir -p ${SANDBOX_APP_DIR} ${NPM_PREFIX} ${NPM_CACHE} ${USER_BIN} ${SANDBOX_HOME}/.config ${SANDBOX_HOME}/workspace ${SANDBOX_HOME}/tmp/opencode`,
      `HOME=${SANDBOX_HOME} UV_CACHE_DIR=${UV_CACHE} UV_PYTHON_INSTALL_DIR=${UV_PYTHON_INSTALL_DIR} uv python install ${PYTHON_VERSION}`,
      `HOME=${SANDBOX_HOME} UV_CACHE_DIR=${UV_CACHE} UV_PYTHON_INSTALL_DIR=${UV_PYTHON_INSTALL_DIR} uv venv --python ${PYTHON_VERSION} ${PYTHON_VENV}`,
      `ln -sf ${PYTHON_VENV}/bin/python ${USER_BIN}/python3`,
      `ln -sf ${PYTHON_VENV}/bin/python ${USER_BIN}/python`,
      `HOME=${SANDBOX_HOME} UV_CACHE_DIR=${UV_CACHE} uv pip install --python ${PYTHON_VENV}/bin/python httpx websockets "pydantic>=2.0" "PyJWT[crypto]"`,
      `sudo rm -rf /app && sudo ln -s ${SANDBOX_APP_DIR} /app`,
      `sudo env npm_config_cache=${NPM_CACHE} npm install -g --prefix ${NPM_PREFIX} pnpm@10 opencode-ai@${OPENCODE_VERSION} @opencode-ai/plugin@${OPENCODE_VERSION} zod@4.4.3 agent-browser@${AGENT_BROWSER_VERSION}`
    )
    .runCommands(
      // GitHub CLI — installed to /usr/bin/gh (the path the runtime's gh wrapper expects).
      // Best-effort end-to-end (keyring + apt source + install) so a cli.github.com hiccup
      // can't fail the build, matching how vercel/bootstrap.ts best-efforts its whole gh block.
      "if ! command -v gh >/dev/null 2>&1; then " +
        "sudo mkdir -p -m 755 /etc/apt/keyrings && " +
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null && " +
        "sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && " +
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null && ' +
        "sudo apt-get update && sudo apt-get install -y gh; " +
        "fi || true",
      // ttyd (terminal) — pinned binary, checksum-verified (matches the Vercel base image).
      `curl -fsSL -o /tmp/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64`,
      `echo "${TTYD_SHA256}  /tmp/ttyd" | sha256sum -c -`,
      "sudo mv /tmp/ttyd /usr/local/bin/ttyd",
      "sudo chmod 0755 /usr/local/bin/ttyd",
      // bun — used by agent-browser and some opencode tooling.
      `curl -fsSL https://bun.sh/install | sudo env BUN_INSTALL=${BUN_INSTALL_DIR} bash || true`,
      // agent-browser Chromium download (best-effort; the shared libs are installed via aptInstall above).
      `sudo env HOME=${SANDBOX_HOME} PATH=${NPM_PREFIX}/bin:${BUN_INSTALL_DIR}/bin:${USER_BIN}:/usr/local/bin:/usr/bin:/bin agent-browser install || true`
    )
    .runCommands(
      `curl -fsSL -o /tmp/code-server.deb https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb`,
      "sudo dpkg -i /tmp/code-server.deb || (sudo apt-get update && sudo apt-get install -f -y)",
      "rm -f /tmp/code-server.deb"
    )
    .runCommands(
      `mkdir -p ${SANDBOX_APP_DIR}/opencode-deps ${SANDBOX_HOME}/workspace ${SANDBOX_HOME}/tmp/opencode`,
      `printf '%s\\n' '{"name":"opencode-tools","type":"module","dependencies":{"@opencode-ai/plugin":"${OPENCODE_VERSION}"}}' | sudo tee /app/opencode-deps/package.json >/dev/null`,
      `cd /app/opencode-deps && sudo env npm_config_cache=${NPM_CACHE} npm install --ignore-scripts --no-audit --no-fund`
    )
    .runCommands(
      HOSTS_BOOTSTRAP,
      DNS_BOOTSTRAP,
      "printf '%s\\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"' | sudo tee /usr/local/bin/oi-git-credentials >/dev/null",
      "sudo chmod 0755 /usr/local/bin/oi-git-credentials",
      "sudo git config --system credential.helper /usr/local/bin/oi-git-credentials",
      "sudo git config --system credential.useHttpPath true",
      // gh CLI auth wrapper — baked here as root, at build time, rather than
      // left to the runtime's _install_gh_wrapper(). That runtime install
      // writes /usr/local/bin/gh as the non-root `sandbox` user, but the dir is
      // root-owned, so the write fails with a swallowed PermissionError and gh
      // is left unauthenticated — agents then can't post PR comments. (It works
      // on Modal only because that runtime is root and can self-install.) Keep
      // this body byte-identical to GH_WRAPPER_BODY in
      // sandbox-runtime/src/sandbox_runtime/entrypoint.py so the runtime install
      // sees a matching file and no-ops instead of failing to overwrite it.
      "printf '%s\\n' '#!/bin/sh' 'REAL_GH=\"/usr/bin/gh\"' 'token=$(python3 -m sandbox_runtime.credentials.git_credential_helper gh-token || true)' 'if [ -n \"$token\" ]; then' '  export GH_TOKEN=\"$token\"' 'fi' 'exec \"$REAL_GH\" \"$@\"' | sudo tee /usr/local/bin/gh >/dev/null",
      "sudo chmod 0755 /usr/local/bin/gh",
      `[ -f ${OPENSANDBOX_PROXY_CA} ] && sudo update-ca-certificates || true`,
      `[ -f ${OPENSANDBOX_PROXY_CA} ] && sudo git config --system http.sslCAInfo ${OPENSANDBOX_PROXY_CA} || true`
    );

  image = addRuntimeDir(image, runtimeDir);

  // The npm/bun/agent-browser installs above run as root (sudo) and write under the sandbox
  // user's HOME, and addRuntimeDir copies the runtime in as root too. Re-own HOME last so the
  // non-root runtime can read/write its own code and the install caches.
  image = image.runCommands(`sudo chown -R sandbox:sandbox ${SANDBOX_HOME} || true`);

  return image
    .env({
      HOME: SANDBOX_HOME,
      XDG_CONFIG_HOME: `${SANDBOX_HOME}/.config`,
      NODE_ENV: "development",
      npm_config_cache: NPM_CACHE,
      npm_config_prefix: NPM_PREFIX,
      UV_CACHE_DIR: UV_CACHE,
      UV_PYTHON_INSTALL_DIR,
      VIRTUAL_ENV: PYTHON_VENV,
      PNPM_HOME: `${SANDBOX_HOME}/.local/share/pnpm`,
      PATH: `${PYTHON_VENV}/bin:${NPM_PREFIX}/bin:${USER_BIN}:${BUN_INSTALL_DIR}/bin:${SANDBOX_HOME}/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin`,
      PYTHONPATH: "/app",
      NODE_PATH: `${NPM_PREFIX}/lib/node_modules:/usr/lib/node_modules`,
      SSL_CERT_FILE: SYSTEM_CA_BUNDLE,
      CURL_CA_BUNDLE: SYSTEM_CA_BUNDLE,
      REQUESTS_CA_BUNDLE: SYSTEM_CA_BUNDLE,
      NODE_EXTRA_CA_CERTS: OPENSANDBOX_PROXY_CA,
      NPM_CONFIG_CAFILE: OPENSANDBOX_PROXY_CA,
      GIT_SSL_CAINFO: OPENSANDBOX_PROXY_CA,
      OPENINSPECT_BIN_INSTALL_DIR: USER_BIN,
      NO_PROXY: LOCAL_NO_PROXY,
      no_proxy: LOCAL_NO_PROXY,
      SANDBOX_VERSION: "opencomputer-v2",
    })
    .workdir(`${SANDBOX_HOME}/workspace`)
    .builderMemory(options.builderMemoryMb);
}

function addRuntimeDir(image: Image, runtimeDir: string): Image {
  let result = image;
  for (const file of collectRuntimeFiles(runtimeDir)) {
    const remotePath = `${SANDBOX_APP_DIR}/sandbox_runtime/${relative(runtimeDir, file)}`;
    result = result.addLocalFile(file, remotePath);
  }
  return result;
}

function collectRuntimeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__pycache__" || entry === ".pytest_cache" || entry === ".ruff_cache") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectRuntimeFiles(fullPath));
    } else if (stat.isFile() && !entry.endsWith(".pyc") && entry !== ".DS_Store") {
      files.push(fullPath);
    }
  }
  return files.sort();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
