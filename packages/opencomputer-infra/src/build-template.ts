import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Image, Snapshots } from "@opencomputer/sdk/node";

const OPENCODE_VERSION = "1.14.41";
const CODE_SERVER_VERSION = "4.109.5";
const PYTHON_VERSION = "3.12";
const SANDBOX_HOME = "/home/sandbox";
const SANDBOX_APP_DIR = `${SANDBOX_HOME}/app`;
const NPM_PREFIX = `${SANDBOX_HOME}/.npm-global`;
const NPM_CACHE = `${SANDBOX_HOME}/.npm-cache`;
const USER_BIN = `${SANDBOX_HOME}/.local/bin`;
const PYTHON_VENV = `${SANDBOX_HOME}/.venv`;
const UV_CACHE = `${SANDBOX_HOME}/.cache/uv`;
const UV_PYTHON_INSTALL_DIR = `${SANDBOX_HOME}/.local/share/uv/python`;
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const OPENSANDBOX_PROXY_CA = "/usr/local/share/ca-certificates/opensandbox-proxy.crt";
const LOCAL_NO_PROXY = "localhost,127.0.0.1,::1";

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
    apiUrl: normalizeApiUrl(
      process.env.OPENCOMPUTER_API_URL || "https://app.opencomputer.dev/api"
    ),
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
      `sudo env npm_config_cache=${NPM_CACHE} npm install -g --prefix ${NPM_PREFIX} pnpm@10 opencode-ai@${OPENCODE_VERSION} @opencode-ai/plugin@${OPENCODE_VERSION} zod`
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
      "printf '%s\\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"' | sudo tee /usr/local/bin/oi-git-credentials >/dev/null",
      "sudo chmod 0755 /usr/local/bin/oi-git-credentials",
      "sudo git config --system credential.helper /usr/local/bin/oi-git-credentials",
      "sudo git config --system credential.useHttpPath true",
      `[ -f ${OPENSANDBOX_PROXY_CA} ] && sudo update-ca-certificates || true`,
      `[ -f ${OPENSANDBOX_PROXY_CA} ] && sudo git config --system http.sslCAInfo ${OPENSANDBOX_PROXY_CA} || true`
    );

  image = addRuntimeDir(image, runtimeDir);

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
      PATH: `${PYTHON_VENV}/bin:${NPM_PREFIX}/bin:${USER_BIN}:${SANDBOX_HOME}/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin`,
      PYTHONPATH: "/app",
      NODE_PATH: `${NPM_PREFIX}/lib/node_modules:/usr/lib/node_modules`,
      SSL_CERT_FILE: SYSTEM_CA_BUNDLE,
      CURL_CA_BUNDLE: SYSTEM_CA_BUNDLE,
      REQUESTS_CA_BUNDLE: SYSTEM_CA_BUNDLE,
      NODE_EXTRA_CA_CERTS: OPENSANDBOX_PROXY_CA,
      NPM_CONFIG_CAFILE: OPENSANDBOX_PROXY_CA,
      GIT_SSL_CAINFO: OPENSANDBOX_PROXY_CA,
      NO_PROXY: LOCAL_NO_PROXY,
      no_proxy: LOCAL_NO_PROXY,
      SANDBOX_VERSION: "opencomputer-v1",
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
