import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOBS, findJob, type JobKind } from "./jobs";

const TERRAFORM_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../terraform/environments/production"
);

/** Where Terraform declares the queue consumer that delivers each kind. */
const QUEUE_CONSUMERS: Record<JobKind, { file: string; resource: string }> = {
  "image_build.finalize": {
    file: "workers-control-plane.tf",
    resource: "image_build_finalization",
  },
  "github.autofix": { file: "workers-github.tf", resource: "github_autofix" },
};

/** The `settings` block of one `cloudflare_queue_consumer` resource. */
function consumerSettings(
  file: string,
  resource: string
): { max_retries: number; retry_delay: number } {
  const source = readFileSync(resolve(TERRAFORM_DIR, file), "utf8");
  const block = new RegExp(
    `resource\\s+"cloudflare_queue_consumer"\\s+"${resource}"\\s*\\{[\\s\\S]*?\\n\\}`
  ).exec(source);
  if (!block) throw new Error(`No cloudflare_queue_consumer "${resource}" in ${file}`);
  const read = (setting: string): number => {
    const match = new RegExp(`\\b${setting}\\s*=\\s*(\\d+)`).exec(block[0]);
    if (!match) throw new Error(`No ${setting} on cloudflare_queue_consumer "${resource}"`);
    return Number(match[1]);
  };
  return { max_retries: read("max_retries"), retry_delay: read("retry_delay") };
}

describe("JOBS", () => {
  it("keys every definition by its own kind", () => {
    for (const [key, definition] of Object.entries(JOBS)) {
      expect(definition.kind).toBe(key);
      expect(findJob(key)).toBe(definition);
    }
    expect(findJob("session.completed")).toBeUndefined();
    // `findJob` reads a kind off the wire: a prototype member is not a job.
    expect(findJob("toString")).toBeUndefined();
  });

  it("declares the delivery policy Terraform deploys for each kind", () => {
    for (const [kind, location] of Object.entries(QUEUE_CONSUMERS) as Array<
      [JobKind, { file: string; resource: string }]
    >) {
      const settings = consumerSettings(location.file, location.resource);
      const definition = JOBS[kind];
      // Cloudflare counts redeliveries; a definition counts deliveries.
      expect(definition.maxAttempts).toBe(settings.max_retries + 1);
      expect(definition.retryDelaySeconds).toBe(settings.retry_delay);
    }
  });
});
