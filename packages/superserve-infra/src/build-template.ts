import { execFileSync } from "node:child_process";
import { NotFoundError, Template, type BuildStep } from "@superserve/sdk";

const OPENCODE_VERSION = "1.17.18";
const CODE_SERVER_VERSION = "4.109.5";
const AGENT_BROWSER_VERSION = "0.21.2";
const TTYD_VERSION = "1.7.7";
const TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55";
const DEFAULT_RUNTIME_REPOSITORY = "https://github.com/ColeMurray/background-agents.git";
const DEFAULT_TEMPLATE_NAME = "openinspect-runtime";
const DEFAULT_BASE_IMAGE = "python:3.12-slim-bookworm";
const DEFAULT_VCPU = 2;
const DEFAULT_MEMORY_MIB = 2048;
const DEFAULT_DISK_MIB = 8192;

interface BuildOptions {
  apiUrl: string;
  apiKey: string;
  templateName: string;
  runtimeRepository: string;
  runtimeRef: string;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const options = resolveOptions(process.argv.slice(2));
  const templateOptions = buildTemplateOptions(options);

  if (options.dryRun) {
    console.log(JSON.stringify(templateOptions, null, 2));
    return;
  }
  if (!options.apiKey) {
    throw new Error("SUPERSERVE_API_KEY is required to build a Superserve template");
  }

  console.log(`Building Superserve template ${options.templateName}`);
  console.log(`API: ${options.apiUrl}`);
  console.log(`Runtime source: ${options.runtimeRepository}@${options.runtimeRef}`);

  const connection = { apiKey: options.apiKey, baseUrl: options.apiUrl };
  let template: Template;
  try {
    template = await Template.connect(options.templateName, connection);
    if (template.status === "ready") {
      console.log(`Superserve template already ready: ${template.name} (${template.id})`);
      return;
    }
    if (template.status === "failed") await template.rebuild();
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    template = await Template.create({ ...templateOptions, ...connection });
  }
  const result = await template.waitUntilReady({
    onLog: (event) => {
      if (event.stream !== "system") process.stdout.write(event.text);
    },
  });
  console.log(`Superserve template ready: ${result.name} (${result.id})`);
}

function resolveOptions(args: string[]): BuildOptions {
  const flags = new Set(args);
  return {
    apiUrl: (process.env.SUPERSERVE_API_URL || "https://api.superserve.ai").replace(/\/+$/, ""),
    apiKey: process.env.SUPERSERVE_API_KEY || "",
    templateName: process.env.SUPERSERVE_TEMPLATE || DEFAULT_TEMPLATE_NAME,
    runtimeRepository: process.env.OPENINSPECT_RUNTIME_REPOSITORY || resolveGitRepository(),
    runtimeRef: process.env.OPENINSPECT_RUNTIME_GIT_REF || resolveGitRef(),
    dryRun: flags.has("--dry-run") || flags.has("--print-manifest"),
  };
}

function resolveGitRepository(): string {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const githubScpMatch = /^git@github\.com:(.+)$/.exec(remote);
    if (githubScpMatch) return `https://github.com/${githubScpMatch[1]}`;
    const githubSshMatch = /^ssh:\/\/git@github\.com\/(.+)$/.exec(remote);
    if (githubSshMatch) return `https://github.com/${githubSshMatch[1]}`;
    if (/^https?:\/\//.test(remote)) {
      const url = new URL(remote);
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    // Fall back to the public upstream repository below.
  }
  return DEFAULT_RUNTIME_REPOSITORY;
}

function resolveGitRef(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "main";
  }
}

function buildTemplateOptions(options: BuildOptions): {
  name: string;
  from: string;
  vcpu: number;
  memoryMib: number;
  diskMib: number;
  steps: BuildStep[];
} {
  const repository = shellQuote(options.runtimeRepository);
  const runtimeRef = shellQuote(options.runtimeRef);
  const steps: BuildStep[] = [
    {
      run:
        "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y " +
        "bash git curl build-essential ca-certificates gnupg openssh-client jq unzip procps " +
        "libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 " +
        "libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 " +
        "libasound2 libpango-1.0-0 libcairo2 ffmpeg",
    },
    {
      run:
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && " +
        "DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs",
    },
    {
      run:
        "mkdir -p -m 755 /etc/apt/keyrings && " +
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg " +
        "> /etc/apt/keyrings/githubcli-archive-keyring.gpg && " +
        "chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && " +
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" ' +
        "> /etc/apt/sources.list.d/github-cli.list && apt-get update && " +
        "DEBIAN_FRONTEND=noninteractive apt-get install -y gh",
    },
    {
      run: 'python -m pip install --no-cache-dir --upgrade pip uv httpx websockets "pydantic>=2.0" "PyJWT[crypto]"',
    },
    {
      run: `npm install -g pnpm@10 opencode-ai@${OPENCODE_VERSION} @opencode-ai/plugin@${OPENCODE_VERSION} zod@4.4.3 agent-browser@${AGENT_BROWSER_VERSION}`,
    },
    { run: "curl -fsSL https://bun.sh/install | bash" },
    {
      run:
        `curl -fsSL -o /tmp/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 && ` +
        `echo "${TTYD_SHA256}  /tmp/ttyd" | sha256sum -c - && ` +
        "mv /tmp/ttyd /usr/local/bin/ttyd && chmod 0755 /usr/local/bin/ttyd",
    },
    {
      run:
        `curl -fsSL -o /tmp/code-server.deb https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb && ` +
        "(dpkg -i /tmp/code-server.deb || (apt-get update && apt-get install -f -y)) && " +
        "rm -f /tmp/code-server.deb",
    },
    { run: "PATH=/root/.bun/bin:$PATH agent-browser install || true" },
    {
      run:
        `rm -rf /tmp/openinspect-source && git clone --filter=blob:none --no-checkout ${repository} /tmp/openinspect-source && ` +
        `git -C /tmp/openinspect-source fetch --depth 1 origin ${runtimeRef} && ` +
        "git -C /tmp/openinspect-source checkout --detach FETCH_HEAD && " +
        "mkdir -p /app /workspace /tmp/opencode && " +
        "cp -R /tmp/openinspect-source/packages/sandbox-runtime/src/sandbox_runtime /app/sandbox_runtime && " +
        "rm -rf /tmp/openinspect-source",
    },
    {
      run:
        `mkdir -p /app/opencode-deps && printf '%s\\n' '${JSON.stringify({ name: "opencode-tools", type: "module", dependencies: { "@opencode-ai/plugin": OPENCODE_VERSION } })}' > /app/opencode-deps/package.json && ` +
        "cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund",
    },
    {
      run:
        "printf '%s\\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"' > /usr/local/bin/oi-git-credentials && " +
        "chmod 0755 /usr/local/bin/oi-git-credentials && " +
        "git config --system credential.helper /usr/local/bin/oi-git-credentials && " +
        "git config --system credential.useHttpPath true",
    },
    {
      run:
        "printf '%s\\n' '#!/bin/sh' 'REAL_GH=\"/usr/bin/gh\"' 'token=$(python3 -m sandbox_runtime.credentials.git_credential_helper gh-token || true)' 'if [ -n \"$token\" ]; then' '  export GH_TOKEN=\"$token\"' 'fi' 'exec \"$REAL_GH\" \"$@\"' > /usr/local/bin/gh && " +
        "chmod 0755 /usr/local/bin/gh",
    },
    { run: "rm -rf /var/lib/apt/lists/* /root/.cache/pip" },
    { env: { key: "HOME", value: "/root" } },
    { env: { key: "NODE_ENV", value: "development" } },
    { env: { key: "PATH", value: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin" } },
    { env: { key: "PYTHONPATH", value: "/app" } },
    { env: { key: "NODE_PATH", value: "/usr/lib/node_modules:/usr/local/lib/node_modules" } },
    { env: { key: "SANDBOX_VERSION", value: "superserve-v1-opencode-1-17-18" } },
    { workdir: "/workspace" },
  ];

  return {
    name: options.templateName,
    from: DEFAULT_BASE_IMAGE,
    vcpu: DEFAULT_VCPU,
    memoryMib: DEFAULT_MEMORY_MIB,
    diskMib: DEFAULT_DISK_MIB,
    steps,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
