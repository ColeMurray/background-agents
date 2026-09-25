/**
 * Executes the review prompt's submission script with real bash and python3, with `curl`, `gh`,
 * and `sleep` replaced by PATH stubs that log their argv and replay scripted results. The script's
 * control flow — which GitHub writes happen, and in what order relative to the lease — is the
 * behavior under test, so it is run rather than pattern-matched.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodeReviewPrompt } from "../src/prompts";

const PROMPT_PARAMS = {
  owner: "acme",
  repo: "widgets",
  number: 42,
  title: "Add caching layer",
  body: null,
  author: "alice",
  base: "main",
  head: "feature/cache",
  headSha: "abc123",
  isDraft: false,
  isPublic: true,
};

const FAKE_CURL = `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$FAKE_DIR/log"
case " $* " in *" DELETE "*) exit 0 ;; esac
next="$(head -n 1 "$FAKE_DIR/acquire")"
tail -n +2 "$FAKE_DIR/acquire" > "$FAKE_DIR/acquire.next" && mv "$FAKE_DIR/acquire.next" "$FAKE_DIR/acquire"
test -n "$next" || next=500
if test "$next" = "fail"; then printf '000'; exit 7; fi
printf '%s' "$next"
`;

const FAKE_GH = `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> "$FAKE_DIR/log"
case "$*" in
  *"/statuses/"*) exit "$(cat "$FAKE_DIR/status_exit")" ;;
  *"/reviews"*)
    code="$(cat "$FAKE_DIR/review_exit")"
    test "$code" = 0 && printf 'https://github.com/acme/widgets/pull/42#pullrequestreview-1'
    exit "$code" ;;
  *"/pulls/"*)
    test -f "$FAKE_DIR/snapshot" || exit 1
    cat "$FAKE_DIR/snapshot"
    exit 0 ;;
esac
exit 0
`;

const FAKE_SLEEP = `#!/usr/bin/env bash
printf 'sleep %s\\n' "$*" >> "$FAKE_DIR/log"
`;

interface SubmissionRun {
  exitCode: number | null;
  /** Every stubbed command, classified: acquire, release, snapshot, review, sleep, status:<state>. */
  calls: string[];
  statusDescriptions: string[];
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function extractSubmissionScript(prompt: string): string {
  const blocks = [...prompt.matchAll(/```sh\n([\s\S]*?)\n```/g)];
  expect(blocks).toHaveLength(1);
  return blocks[0][1];
}

function classify(line: string): string {
  if (line.startsWith("sleep ")) return "sleep";
  if (line.startsWith("curl ")) return line.includes(" DELETE ") ? "release" : "acquire";
  if (line.includes("/statuses/")) return `status:${/state=(\w+)/.exec(line)?.[1]}`;
  if (line.includes("/reviews")) return "review";
  return "snapshot";
}

function runSubmission(
  options: {
    acquire?: string[];
    snapshot?: string | null;
    reviewExit?: number;
    statusExit?: number;
    env?: Record<string, string | undefined>;
    isDraft?: boolean;
  } = {}
): SubmissionRun {
  const directory = mkdtempSync(join(tmpdir(), "oi-review-submission-"));
  directories.push(directory);
  for (const [name, source] of [
    ["curl", FAKE_CURL],
    ["gh", FAKE_GH],
    ["sleep", FAKE_SLEEP],
  ]) {
    writeFileSync(join(directory, name), source);
    chmodSync(join(directory, name), 0o755);
  }
  writeFileSync(join(directory, "log"), "");
  writeFileSync(join(directory, "acquire"), (options.acquire ?? ["204"]).join("\n") + "\n");
  writeFileSync(join(directory, "review_exit"), String(options.reviewExit ?? 0));
  writeFileSync(join(directory, "status_exit"), String(options.statusExit ?? 0));
  const snapshot = options.snapshot === undefined ? "abc123 open draft:false" : options.snapshot;
  if (snapshot !== null) writeFileSync(join(directory, "snapshot"), snapshot);

  const script = extractSubmissionScript(
    buildCodeReviewPrompt({ ...PROMPT_PARAMS, isDraft: options.isDraft ?? false })
  );
  const env: Record<string, string> = {
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    FAKE_DIR: directory,
    SESSION_CONFIG: JSON.stringify({ session_id: "session-1" }),
    CONTROL_PLANE_URL: "https://control-plane.test",
    SANDBOX_AUTH_TOKEN: "sandbox-token",
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // No rc files: some bash builds source ~/.bashrc when stdin is a socket, which can reset PATH.
  const result = spawnSync("bash", ["--norc", "--noprofile", "-c", script], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = readFileSync(join(directory, "log"), "utf8").split("\n").filter(Boolean);
  return {
    exitCode: result.status,
    calls: lines.map(classify),
    statusDescriptions: lines
      .filter((line) => line.includes("/statuses/"))
      .map((line) => /description=(.*?)(?: -f |$)/.exec(line)?.[1] ?? ""),
  };
}

describe("review submission script", () => {
  it("submits the review and its success status under the lease, then releases it", () => {
    const run = runSubmission();

    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual(["snapshot", "acquire", "review", "status:success", "release"]);
    expect(run.statusDescriptions).toEqual(["Review completed"]);
  });

  it("writes nothing to GitHub when a newer review owns the status (409)", () => {
    const run = runSubmission({ acquire: ["409"] });

    expect(run.exitCode).toBe(0);
    expect(run.calls.filter((call) => call === "review" || call.startsWith("status:"))).toEqual([]);
  });

  it("accepts the draft state the review was admitted with", () => {
    const run = runSubmission({ isDraft: true, snapshot: "abc123 open draft:true" });

    expect(run.calls).toContain("status:success");
  });
});
