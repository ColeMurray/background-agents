import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  new URL("../.github/workflows/terraform.yml", import.meta.url),
  "utf8"
);
const formatter = fileURLToPath(new URL("./terraform-plan-comment.mjs", import.meta.url));
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const maliciousPlan = [
  "`; globalThis.__terraformPlanExecuted = true; //",
  "${globalThis.__terraformPlanExecuted = true}",
  "${{ secrets.GITHUB_TOKEN }}",
  "\"double quotes\", 'single quotes', $(touch injected), `touch injected`",
  "EOF\nplan<<EOF\n::error::injected error\n::set-output name=plan::injected",
  "\u001b[31mANSI red\u001b[0m\u001b]0;terminal title\u0007",
  "</pre></details><script>alert('injected')</script>&",
].join("\n");

function stepBody(name) {
  const body = workflow
    .split(`      - name: ${name}\n`)[1]
    ?.split(/\n {6}- name:|\n {2}\w[\w-]*:\n/)[0];
  assert.ok(body, `expected the ${name} step`);
  return body;
}

function block(name, key, indentation) {
  const match = stepBody(name).match(new RegExp(`${key}: \\|\\n((?: {${indentation}}.*\\n|\\n)*)`));
  assert.ok(match, `expected a ${key} block in ${name}`);
  return match[1].replace(new RegExp(`^ {${indentation}}`, "gm"), "");
}

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "terraform comment "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function formatComment(t, plan, outcome = "success") {
  const directory = tempDirectory(t);
  const inputPath = join(directory, "plan_output.txt");
  const outputPath = join(directory, "plan_comment.txt");
  writeFileSync(inputPath, plan);
  const result = spawnSync(process.execPath, [formatter, inputPath, outputPath, outcome], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTOR: "contributor" },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return { path: outputPath, body: readFileSync(outputPath, "utf8") };
}

async function postComment(path, createComment, notices = []) {
  // Execute the workflow's static script with the artifact available only as file data.
  const script = block("Post Plan Results", "script", 12);
  await new AsyncFunction("github", "context", "core", "require", "process", script)(
    { rest: { issues: { createComment } } },
    { issue: { number: 260 }, repo: { owner: "owner", repo: "repo" } },
    { notice: (message) => notices.push(message) },
    require,
    { env: { PLAN_COMMENT_PATH: path } }
  );
}

test("malicious plan text is sanitized and posted as inert data", async (t) => {
  const comment = formatComment(t, maliciousPlan);
  const comments = [];
  await postComment(comment.path, async (parameters) => comments.push(parameters));
  assert.equal(globalThis.__terraformPlanExecuted, undefined);
  assert.deepEqual(comments, [
    { issue_number: 260, owner: "owner", repo: "repo", body: comment.body },
  ]);
  assert.ok(comment.body.includes("`; globalThis.__terraformPlanExecuted = true; //"));
  assert.ok(comment.body.includes("${globalThis.__terraformPlanExecuted = true}"));
  assert.ok(comment.body.includes("${{ secrets.GITHUB_TOKEN }}"));
  assert.ok(
    comment.body.includes("\"double quotes\", 'single quotes', $(touch injected), `touch injected`")
  );
  assert.ok(comment.body.includes("EOF\nplan&lt;&lt;EOF\n::error::injected error"));
  assert.ok(comment.body.includes("ANSI red"));
  assert.ok(!comment.body.includes("\u001b"));
  assert.ok(!comment.body.includes("terminal title"));
  assert.ok(comment.body.includes("&lt;/pre&gt;&lt;/details&gt;&lt;script&gt;"));
  assert.equal(comment.body.match(/<pre>/g).length, 1);
  assert.equal(comment.body.match(/<\/pre>/g).length, 1);
  assert.ok(comment.body.includes("**Status:** Success"));
});

test("plan truncation fits the comment budget after escaping and preserves the closing tags", (t) => {
  const comment = formatComment(t, "<&>".repeat(30000), "failure");
  assert.ok(Buffer.byteLength(comment.body) < 65536);
  assert.ok(comment.body.includes("\n... (truncated)</pre>\n\n</details>"));
  assert.doesNotMatch(comment.body.split("\n... (truncated)")[0], /&[^;]*$/);
  assert.ok(comment.body.includes("**Status:** Failed"));
  assert.ok(comment.body.endsWith("*Pushed by: @contributor*\n"));
});

test("truncation does not split a UTF-8 character", (t) => {
  const comment = formatComment(t, "a".repeat(59999) + "\u{1f680}".repeat(1000));
  assert.ok(comment.body.includes("a".repeat(59999) + "\n... (truncated)</pre>"));
  assert.ok(!comment.body.includes("\ufffd"));
});

test("short plan output without a final newline and empty output remain well formed", (t) => {
  for (const plan of ["No changes.", ""]) {
    const comment = formatComment(t, plan);
    assert.ok(comment.body.includes(`<pre>${plan}</pre>`));
    assert.ok(!comment.body.includes("(truncated)"));
  }
});

for (const exitCode of [0, 1, 42]) {
  test(`the workflow capture preserves Terraform exit code ${exitCode} and records stderr`, (t) => {
    const directory = tempDirectory(t);
    writeFileSync(
      join(directory, "terraform"),
      '#!/usr/bin/env bash\nprintf "%s" "$STUB_PLAN_TEXT"\nprintf "%s" "$STUB_PLAN_ERROR" >&2\nexit "$STUB_EXIT_CODE"\n',
      { mode: 0o755 }
    );
    const githubOutput = join(directory, "github_output");
    writeFileSync(githubOutput, "existing=value\n");
    const planText = exitCode === 0 ? maliciousPlan + "\n" + "x".repeat(65000) : maliciousPlan;
    const result = spawnSync("bash", ["-e", "-c", block("Terraform Plan", "run", 10)], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_OUTPUT: githubOutput,
        STUB_PLAN_TEXT: planText,
        STUB_PLAN_ERROR: "\nTerraform stderr without a final newline",
        STUB_EXIT_CODE: String(exitCode),
      },
    });
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(
      readFileSync(join(directory, "plan_output.txt"), "utf8"),
      planText + "\nTerraform stderr without a final newline"
    );
    assert.equal(readFileSync(githubOutput, "utf8"), "existing=value\n");
    const token = result.stdout.match(/^::stop-commands::([a-f0-9]{64})\n/)[1];
    assert.ok(
      result.stdout.endsWith(`\n::${token}::\n`),
      "resume commands on their own line, including on failure"
    );
    const prepare = spawnSync(
      "bash",
      ["-e", "-c", stepBody("Prepare Plan Comment").match(/run: (.*)/)[1]],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)),
          GITHUB_ACTOR: "contributor",
          PLAN_OUTCOME: exitCode === 0 ? "success" : "failure",
        },
        timeout: 10000,
      }
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    const comment = readFileSync(join(directory, "plan_comment.txt"), "utf8");
    assert.ok(comment.includes(`**Status:** ${exitCode === 0 ? "Success" : "Failed"}`));
    assert.ok(Buffer.byteLength(comment) < 65536);
    if (exitCode !== 0) {
      assert.match(stepBody("Plan Status"), /if: always\(\) && steps\.plan\.outcome == 'failure'/);
      const gate = stepBody("Plan Status").match(/run: (.*)/)[1];
      assert.equal(spawnSync("bash", ["-e", "-c", gate]).status, 1);
    }
  });
}

test("read-only fork comment failures are tolerated but other API failures are propagated", async (t) => {
  const comment = formatComment(t, "No changes.");
  const notices = [];
  await postComment(
    comment.path,
    async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    },
    notices
  );
  assert.equal(notices.length, 1);
  await assert.rejects(
    postComment(comment.path, async () => {
      throw Object.assign(new Error("Server error"), { status: 500 });
    }),
    /Server error/
  );
});

test("commenting has minimal permissions and never checks out or executes PR code", () => {
  assert.equal(workflow.match(/^permissions:\n((?: {2}.*\n)+)/m)[1], "  contents: read\n");
  const commentJob = workflow.split("\n  comment:\n")[1].split("\n  apply:\n")[0];
  assert.equal(
    commentJob.match(/ {4}permissions:\n((?: {6}.*\n)+)/)[1],
    "      pull-requests: write\n"
  );
  assert.doesNotMatch(commentJob, /actions\/checkout|^\s*run:|\$\{\{\s*secrets\./m);
  assert.match(commentJob, /needs: \[validate, check-secrets, plan\]/);
  assert.match(
    commentJob,
    /if: always\(\) && !cancelled\(\) && github\.event_name == 'pull_request'/
  );
  for (const name of ["Post Validation Results", "Post Plan Results"]) {
    assert.doesNotMatch(block(name, "script", 12), /\$\{\{/);
  }
  const planJob = workflow.split("\n  plan:\n")[1].split("\n  comment:\n")[0];
  assert.match(planJob, /terraform_wrapper: false/);
  assert.doesNotMatch(planJob, /github-script|GITHUB_OUTPUT|steps\.plan\.outputs\.plan/);
  assert.match(stepBody("Terraform Plan"), /shell: bash/);
  assert.match(stepBody("Terraform Plan"), /continue-on-error: true/);
  for (const name of ["Prepare Plan Comment", "Upload Plan Comment"]) {
    assert.match(
      stepBody(name),
      /if: always\(\) && \(steps\.plan\.outcome == 'success' \|\| steps\.plan\.outcome == 'failure'\)/
    );
  }
  assert.match(
    stepBody("Upload Plan Comment"),
    /path: \$\{\{ env\.TF_WORKING_DIR \}\}\/plan_comment\.txt\n/
  );
});

test("workflow-only changes trigger the security regression tests in CI", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.equal(ci.split('      - ".github/workflows/terraform.yml"').length - 1, 2);
  assert.match(ci, /run: npm run test:terraform-workflow-contract/);
});
