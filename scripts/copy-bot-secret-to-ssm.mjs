import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Copy one existing receiver key; never rotate it or print captured CLI output. */
export function copyBotSecret(argv, execute = spawnSync) {
  const [bot, terraformDir, prefix, confirmation] = argv;
  if (
    argv.length !== 4 ||
    !["slack", "linear"].includes(bot) ||
    !terraformDir ||
    !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(prefix ?? "") ||
    confirmation !== "--execute"
  ) {
    throw new Error(
      "Usage: node copy-bot-secret-to-ssm.mjs <slack|linear> <cloudflare-terraform-dir> <ssm-prefix> --execute"
    );
  }
  const parameter = `${prefix}/SERVICE_AUTH_SECRET_${bot.toUpperCase()}_BOT`;
  const output = execute(
    "terraform",
    [`-chdir=${resolve(terraformDir)}`, "output", "-raw", `service_auth_secret_${bot}_bot`],
    {
      encoding: "utf8",
      timeout: 60_000,
      // A caller's Terraform debug setting must not turn the export into a log.
      env: { ...process.env, TF_LOG: "OFF", TF_LOG_CORE: "OFF", TF_LOG_PROVIDER: "OFF" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (output.error || output.status !== 0 || !/^[A-Za-z0-9]{64}$/.test(output.stdout ?? "")) {
    throw new Error(
      "Bot key export failed or output is invalid; AWS was not changed. Check the selected Cloudflare state, enabled bot and sensitive output."
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "open-inspect-bot-secret-"));
  try {
    const request = join(directory, "request.json");
    writeFileSync(
      request,
      JSON.stringify({
        Name: parameter,
        Value: output.stdout,
        Type: "SecureString",
        Overwrite: true,
      }),
      { mode: 0o600 }
    );
    const result = execute(
      "aws",
      ["ssm", "put-parameter", "--cli-input-json", `file://${request}`],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        "AWS key handoff did not confirm success; check credentials, region and target parameter. A timed-out write may have completed. Captured output was suppressed to protect the key."
      );
    }
    return parameter;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(`Updated ${copyBotSecret(process.argv.slice(2))}; no key was printed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
