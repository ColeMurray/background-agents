import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Image, Sandbox, Snapshots } from "@opencomputer/sdk/node";
import { packImage, writeBuildResult } from "../../sandbox-images/src/node";
const SYSTEM_CA_BUNDLE = "/etc/pki/tls/certs/ca-bundle.crt";
const providerEnvironment = {
  SSL_CERT_FILE: SYSTEM_CA_BUNDLE,
  CURL_CA_BUNDLE: SYSTEM_CA_BUNDLE,
  REQUESTS_CA_BUNDLE: SYSTEM_CA_BUNDLE,
  NODE_EXTRA_CA_CERTS: SYSTEM_CA_BUNDLE,
  NPM_CONFIG_CAFILE: SYSTEM_CA_BUNDLE,
  GIT_SSL_CAINFO: SYSTEM_CA_BUNDLE,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
};

export async function main(): Promise<void> {
  const root =
    process.env.OPENINSPECT_REPO_ROOT ||
    execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const packed = packImage(root, "opencomputer");
  let image = Image.base().env(providerEnvironment);
  for (const file of packed.files) {
    image = image.addLocalFile(join(packed.directory, file), `/tmp/openinspect-image/${file}`);
  }
  image = image
    .runCommands("bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh")
    .env({
      ...packed.plan.runtimeEnv,
      ...providerEnvironment,
      SANDBOX_VERSION: packed.plan.runtimeVersion,
    })
    .workdir("/workspace")
    .builderMemory(Number(process.env.OPENCOMPUTER_BUILDER_MEMORY_MB || 8192));
  if (process.argv.includes("--dry-run") || process.argv.includes("--print-manifest")) {
    console.log(JSON.stringify(image.toJSON(), null, 2));
    return;
  }
  const apiKey = process.env.OPENCOMPUTER_API_KEY;
  if (!apiKey) throw new Error("OPENCOMPUTER_API_KEY is required");
  const baseUrl = (process.env.OPENCOMPUTER_API_URL || "https://app.opencomputer.dev/api").replace(
    /\/+$/,
    ""
  );
  const apiUrl = baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`;
  const name =
    process.env.OPENINSPECT_IMAGE_CANDIDATE ||
    `${process.env.OPENCOMPUTER_TEMPLATE || "openinspect-runtime"}-${packed.plan.buildHash.slice(0, 12)}-${Date.now()}`;
  const snapshots = new Snapshots({ apiUrl, apiKey });
  const retained = (await snapshots.list()).some((snapshot) => snapshot.name === name);
  const artifact = retained
    ? await snapshots.get(name)
    : await snapshots.create({ name, image, onBuildLogs: (log) => console.log(log) });
  if (artifact.status !== "ready")
    throw new Error(`OpenComputer candidate status is ${artifact.status}`);
  const sandbox = await Sandbox.create({ apiUrl, apiKey, snapshot: name });
  try {
    if (!sandbox.endAt) {
      throw new Error(
        "OpenComputer verification sandbox omitted endAt; verify the organization's runtime pin uses v2"
      );
    }
    const report = await sandbox.exec.run(
      `/opt/openinspect/python/bin/python /app/verify/smoke_test.py verify`,
      { env: providerEnvironment, timeout: 240, timeoutMs: 250_000 }
    );
    if (report.exitCode !== 0)
      throw new Error(`OpenComputer verification failed: ${report.stderr}`);
    writeBuildResult(name);
  } finally {
    await sandbox.kill();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
