// What `scripts/deploy-aws.sh` does when a deploy goes wrong.
//
// The rollback is the part that matters and the part nobody exercises by
// hand: it only runs when a deploy has already failed, which is exactly when
// nobody wants to be discovering that the rollback is broken too. So the AWS
// CLI and curl are replaced with stubs that record what was asked of them, and
// the health check is made to fail on demand.
//
// The stub `aws` materializes the deployed-image parameter on activation, and
// `curl` fails while that running image is bad -- so a rollback makes the
// service healthy again, the way it would in reality.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("./deploy-aws.sh", import.meta.url));
const REPOSITORY = "123456789012.dkr.ecr.us-west-2.amazonaws.com/control-plane";
const OLD_DIGEST = `sha256:${"a".repeat(64)}`;
const NEW_DIGEST = `sha256:${"b".repeat(64)}`;
const OLD = `${REPOSITORY}@${OLD_DIGEST}`;
const NEW = `${REPOSITORY}@${NEW_DIGEST}`;

const AWS_STUB = `#!/bin/bash
# Stand-in for the AWS CLI. Only the calls deploy-aws.sh makes.
set -uo pipefail
state="$STUB_DIR/deployed"
log="$STUB_DIR/calls"
echo "aws $*" >>"$log"

case "$2" in
  describe-images)
    [ "$STUB_RESOLVE_FAILS" = "0" ] || exit 1
    cat "$STUB_DIR/registry_digest"
    ;;
  get-parameter) cat "$state" ;;
  put-parameter)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--value" ]; then printf '%s' "$2" >"$state"; fi
      shift
    done
    ;;
  send-command)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--parameters" ]; then printf '%s' "$2" >"$STUB_DIR/parameters"; fi
      shift
    done
    echo sent >>"$STUB_DIR/activations"
    ref="$(cat "$state")"
    case "$ref" in
      *@sha256:*) printf '%s' "$ref" >"$STUB_DIR/running" ;;
      *) printf '%s@%s' "\${ref%:*}" "$(cat "$STUB_DIR/registry_digest")" >"$STUB_DIR/running" ;;
    esac
    echo "\${AWS_MAX_ATTEMPTS:-unset}" >"$STUB_DIR/send_attempts"
    [ "$STUB_SEND_FAILS" = "0" ] || exit 1
    echo "command-$(wc -l <"$STUB_DIR/activations" | tr -d ' ')"
    ;;
  get-command-invocation)
    case " $* " in
      *StandardOutputContent*) echo "remote output" ;;
      *)
        status="$(head -n 1 "$STUB_DIR/command_status")"
        if [ "$(wc -l <"$STUB_DIR/command_status")" -gt 1 ]; then
          tail -n +2 "$STUB_DIR/command_status" >"$STUB_DIR/next_status"
          mv "$STUB_DIR/next_status" "$STUB_DIR/command_status"
        fi
        [ "$status" != ReadError ] || exit 1
        echo "$status"
        ;;
    esac
    ;;
  *)
    echo "unexpected aws call: $*" >&2
    exit 64
    ;;
esac
`;

// Fails while the deployed image is the one the test declared bad, so the
// rollback is what makes it pass. `good_checks` lets a bad image answer a few
// times before it starts failing -- a container that comes up, serves, and
// then falls over, which is the case a single 200 would wave through.
const CURL_STUB = `#!/bin/bash
set -uo pipefail
echo probe >>"$STUB_DIR/probes"
probes="$(wc -l <"$STUB_DIR/probes" | tr -d ' ')"

# One nominated probe fails, whatever is deployed: a blip, not a bad image.
if [ "$probes" = "$(cat "$STUB_DIR/fail_on_probe")" ]; then exit 22; fi

bad="$(cat "$STUB_DIR/bad_image")"
deployed="$(cat "$STUB_DIR/running")"
[ -n "$bad" ] || exit 0
[ "$deployed" = "$bad" ] || exit 0

# A bad image may answer a few times before it starts failing -- a container
# that comes up, serves, and then falls over.
if [ "$probes" -le "$(cat "$STUB_DIR/good_checks")" ]; then exit 0; fi
exit 22
`;

function runDeploy({
  previous,
  image,
  badImage = "",
  commandStatus = "Success",
  sendFails = false,
  pinOnly = false,
  bootstrap = false,
  registryDigest = OLD_DIGEST,
  resolveFails = false,
  goodChecks = 0,
  failOnProbe = 0,
}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-aws-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);

  writeFileSync(join(dir, "deployed"), previous);
  writeFileSync(join(dir, "running"), OLD);
  writeFileSync(join(dir, "registry_digest"), registryDigest);
  writeFileSync(join(dir, "bad_image"), badImage);
  writeFileSync(join(dir, "good_checks"), String(goodChecks));
  writeFileSync(join(dir, "fail_on_probe"), String(failOnProbe));
  writeFileSync(join(dir, "probes"), "");
  writeFileSync(join(dir, "command_status"), [commandStatus].flat().join("\n") + "\n");
  writeFileSync(join(dir, "activations"), "");
  writeFileSync(join(dir, "calls"), "");
  writeFileSync(join(dir, "parameters"), "");
  writeFileSync(join(dir, "send_attempts"), "");
  // Advance Bash's own monotonic clock on sleep, so the real polling loop and
  // deadlines run without a wall-clock wait or altered production source.
  const clock = join(dir, "clock.sh");
  writeFileSync(clock, "sleep() { SECONDS=$((SECONDS + 1)); }\n");

  for (const [name, body] of [
    ["aws", AWS_STUB],
    ["curl", CURL_STUB],
    [
      "docker",
      // Execute the workflow's actual build/push shell against a mutable fake
      // registry. Pushing either tag changes its resolution, just as ECR does.
      `#!/bin/bash
echo "docker $*" >>"$STUB_DIR/calls"
if [ "$1" = push ]; then printf '%s' "$STUB_NEW_DIGEST" >"$STUB_DIR/registry_digest"; fi
`,
    ],
  ]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }

  const options = {
    encoding: "utf8",
    timeout: 10000,
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_DIR: dir,
      STUB_SEND_FAILS: sendFails ? "1" : "0",
      STUB_RESOLVE_FAILS: resolveFails ? "1" : "0",
      STUB_NEW_DIGEST: NEW_DIGEST,
      BASH_ENV: clock,
      AWS_REGION: "us-west-2",
      AWS_ECR_REPOSITORY: REPOSITORY,
      REPOSITORY,
      REGION: "us-west-2",
      GITHUB_SHA: "c".repeat(40),
      GITHUB_OUTPUT: join(dir, "output"),
      DEPLOYED_IMAGE_PARAMETER: "/open-inspect-staging/env/CONTROL_PLANE_IMAGE",
      INSTANCE_ID: "i-0123456789abcdef0",
      HEALTHCHECK_URL: "https://example.invalid/healthz",
      IMAGE_REF: image,
      // Compressed so the suite runs in seconds rather than minutes.
      COMMAND_POLL_SECONDS: "0",
      COMMAND_TIMEOUT_SECONDS: "5",
      COMMAND_DELIVERY_TIMEOUT_SECONDS: "30",
      COMMAND_GRACE_SECONDS: "0",
      HEALTH_INTERVAL_SECONDS: "0",
      HEALTH_TIMEOUT_SECONDS: "10",
      HEALTH_CONSECUTIVE: "2",
    },
  };
  let result;
  if (bootstrap) {
    const workflow = readFileSync(
      new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
      "utf8"
    );
    const pin = workflow.indexOf("run: scripts/deploy-aws.sh --pin-current-image");
    const build = workflow.indexOf("- name: Build and push the image");
    assert.ok(pin >= 0 && pin < build, "pin the rollback image before the workflow pushes tags");
    result = spawnSync("bash", [SCRIPT, "--pin-current-image"], options);
    if (result.status === 0) {
      const body = workflow.slice(build).match(/ {8}run: \|\n([\s\S]*?)\n {6}- name:/)[1];
      result = spawnSync("bash", ["-eo", "pipefail", "-c", body.replace(/^ {10}/gm, "")], options);
      if (result.status === 0) {
        options.env.IMAGE_REF = readFileSync(join(dir, "output"), "utf8")
          .trim()
          .slice("ref=".length);
        result = spawnSync("bash", [SCRIPT], options);
      }
    }
  } else {
    result = spawnSync("bash", pinOnly ? [SCRIPT, "--pin-current-image"] : [SCRIPT], options);
  }

  const countLines = (name) => {
    const body = readFileSync(join(dir, name), "utf8").trim();
    return body === "" ? 0 : body.split("\n").length;
  };

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    deployed: readFileSync(join(dir, "deployed"), "utf8"),
    running: readFileSync(join(dir, "running"), "utf8"),
    registryDigest: readFileSync(join(dir, "registry_digest"), "utf8"),
    calls: readFileSync(join(dir, "calls"), "utf8"),
    parameters: readFileSync(join(dir, "parameters"), "utf8"),
    sendAttempts: readFileSync(join(dir, "send_attempts"), "utf8").trim(),
    activations: countLines("activations"),
    probes: countLines("probes"),
  };
}

test("a healthy deploy leaves the new image deployed", () => {
  const run = runDeploy({ previous: OLD, image: NEW });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.deployed, NEW);
  assert.equal(run.activations, 1, "no rollback should have been attempted");
});

test("the first workflow deployment rolls back to the bootstrap digest after latest moves", () => {
  const run = runDeploy({
    previous: `${REPOSITORY}:latest`,
    image: NEW,
    badImage: NEW,
    bootstrap: true,
  });

  assert.equal(run.status, 1, run.output);
  assert.equal(run.registryDigest, NEW_DIGEST, "the actual workflow must have overwritten latest");
  assert.equal(run.deployed, OLD, "rollback restores the digest captured before the push");
  assert.equal(run.running, OLD, "the old image is running, not merely named in SSM");
  assert.equal(run.activations, 2);
  assert.ok(run.calls.indexOf("describe-images") < run.calls.indexOf("docker push"));
});

test("a same-commit tag rebuild preserves the previous image for rollback", () => {
  const run = runDeploy({
    previous: `${REPOSITORY}:${"c".repeat(40)}`,
    image: NEW,
    badImage: NEW,
    bootstrap: true,
  });

  assert.equal(run.status, 1);
  assert.equal(run.deployed, OLD);
  assert.equal(run.running, OLD);
  assert.equal(run.registryDigest, NEW_DIGEST);
});

test("an already pinned rollback image needs neither lookup nor write", () => {
  const run = runDeploy({ previous: OLD, pinOnly: true });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.deployed, OLD);
  assert.doesNotMatch(run.calls, /describe-images|put-parameter|send-command/);
});

for (const options of [
  { registryDigest: "None" },
  { registryDigest: "sha256:invalid" },
  { resolveFails: true },
]) {
  test(`a bootstrap image that cannot be resolved stops before pushes: ${JSON.stringify(options)}`, () => {
    const previous = `${REPOSITORY}:latest`;
    const run = runDeploy({ previous, image: NEW, bootstrap: true, ...options });

    assert.notEqual(run.status, 0);
    assert.equal(run.deployed, previous);
    assert.equal(run.running, OLD);
    assert.doesNotMatch(run.calls, /put-parameter|docker push|send-command/);
  });
}

test("a tag outside the configured ECR repository must be pinned explicitly", () => {
  const previous = "example.invalid/control-plane:latest";
  const run = runDeploy({ previous, pinOnly: true });

  assert.equal(run.status, 1);
  assert.equal(run.deployed, previous);
  assert.doesNotMatch(run.calls, /describe-images|put-parameter|send-command/);
});

test("deployment refuses an unpinned rollback image before changing anything", () => {
  const previous = `${REPOSITORY}:latest`;
  const run = runDeploy({ previous, image: NEW });

  assert.equal(run.status, 1);
  assert.equal(run.deployed, previous);
  assert.doesNotMatch(run.calls, /put-parameter|send-command/);
});

test("an image that never becomes healthy is rolled back, and the job still fails", () => {
  const run = runDeploy({ previous: OLD, image: NEW, badImage: NEW });

  assert.equal(run.deployed, OLD, "the previous image must be restored");
  assert.equal(run.activations, 2, "the rollback must be activated, not just written");
  assert.ok(run.output.includes(`rolled back to ${OLD}`));
  // The rollback working is not success: whatever was merged is not running.
  assert.equal(run.status, 1);
});

test("a remote command that fails rolls back without waiting for a health check", () => {
  const run = runDeploy({ previous: OLD, image: NEW, commandStatus: "Failed" });

  assert.equal(run.deployed, OLD);
  assert.equal(run.status, 1);
  // Both the deploy and the rollback run the command; the rollback's also
  // "fails", so this proves the failure path does not strand the parameter.
  assert.equal(run.activations, 2);
  assert.match(run.output, /needs a human/);
});

test("a delayed activation can finish after the execution-only polling deadline", () => {
  const run = runDeploy({
    previous: OLD,
    image: NEW,
    commandStatus: [...Array(15).fill("Delayed"), ...Array(17).fill("In Progress"), "Success"],
  });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.activations, 1, "delivery delay must not trigger an overlapping rollback");
  assert.equal(run.deployed, NEW);
});

for (const commandStatus of [
  "Pending",
  "InProgress",
  "In Progress",
  "Cancelling",
  "ReadError",
  "Delivery Timed Out",
  "UnknownStatus",
]) {
  test(`an uncertain activation (${commandStatus}) never starts rollback`, () => {
    const run = runDeploy({ previous: OLD, image: NEW, commandStatus });

    assert.equal(run.status, 1, run.output);
    assert.equal(run.activations, 1);
    assert.equal(run.deployed, NEW, "do not change configuration beneath an uncertain execution");
    assert.equal(run.probes, 0, "a healthy old container cannot resolve command uncertainty");
    assert.match(run.output, /ACTIVATION OUTCOME UNKNOWN/);
    assert.ok(run.output.includes(OLD), "retain the recovery image in diagnostics");
  });
}

test("an agent-confirmed execution timeout permits rollback", () => {
  const run = runDeploy({
    previous: OLD,
    image: NEW,
    commandStatus: ["Execution Timed Out", "Success"],
  });

  assert.equal(run.status, 1);
  assert.equal(run.activations, 2);
  assert.equal(run.deployed, OLD);
  assert.match(run.output, /rolled back/);
});

test("a lost SendCommand response neither retries submission nor starts rollback", () => {
  const run = runDeploy({ previous: OLD, image: NEW, sendFails: true });

  assert.equal(run.status, 1);
  assert.equal(run.activations, 1);
  assert.equal(run.sendAttempts, "1");
  assert.equal(run.deployed, NEW);
  assert.match(run.output, /ACTIVATION OUTCOME UNKNOWN/);
});

test("the previous value is read before anything moves", () => {
  // A deploy of the image already deployed still activates, so that a change to
  // the compose files or any other parameter is picked up.
  const run = runDeploy({ previous: NEW, image: NEW });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.activations, 1);
  assert.match(run.output, /already deployed/);
});

test("an image that answers once and then falls over is not healthy", () => {
  // The whole point of requiring consecutive checks: one 200 proves the port is
  // open, not that the deployment works.
  const run = runDeploy({ previous: OLD, image: NEW, badImage: NEW, goodChecks: 1 });

  assert.equal(run.deployed, OLD, "a flapping image must still be rolled back");
  assert.equal(run.status, 1);
  assert.match(run.output, /flapped after 1 good check/);
});

test("a single failed check restarts the count rather than resuming it", () => {
  // Two consecutive successes are required, and probe 2 fails. Restarting the
  // count needs four probes (ok, fail, ok, ok); merely pausing it would be
  // satisfied by three.
  const run = runDeploy({ previous: OLD, image: NEW, failOnProbe: 2 });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.deployed, NEW);
  assert.equal(run.probes, 4);
});

test("the remote command bounds its own execution and assumes nothing about the host", () => {
  const run = runDeploy({ previous: OLD, image: NEW });
  const sent = run.calls.split("\n").filter((line) => line.includes("send-command"));
  assert.equal(sent.length, 1);

  // The whole payload, not a substring of it: a malformed parameters document
  // reaches AWS looking much like a well-formed one from the outside.
  const parameters = JSON.parse(run.parameters);

  // The instance ignores user_data_base64, so a host keeps whatever cloud-init
  // wrote at its first boot. Naming anything installed that way makes a deploy
  // depend on how old the instance is; the fetch brings the rest down itself,
  // including the activation script it hands off to.
  //
  // One entry, not two: AWS-RunShellScript reports the status of the last
  // command it ran, so two would report a successful activation over a failed
  // fetch. The test below is what proves the `&&` does its job.
  assert.deepEqual(parameters.commands, [
    "/usr/local/bin/open-inspect-fetch-config && exec bash /opt/open-inspect/deploy.sh",
  ]);

  // Without executionTimeout the document runs to completion whatever this
  // script does, and the rollback would pull and recreate containers underneath
  // an activation still doing the same. `--timeout-seconds` does not cover it:
  // that bounds delivery, not the shell. "30" rather than this run's 5-second
  // budget because the document rejects anything lower, so the script floors it.
  assert.deepEqual(parameters.executionTimeout, ["30"]);
});

// Runs the payload's command with the two absolute paths it names replaced by
// stubs. What is under test is the shell between them, not where they live --
// the deepEqual above is what holds the paths.
function runRemoteCommand(command, { fetchExits }) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-aws-remote-"));
  const fetch = join(dir, "fetch");
  const activate = join(dir, "activate");
  const marker = join(dir, "activated");

  writeFileSync(fetch, `#!/bin/bash\nexit ${fetchExits}\n`);
  writeFileSync(activate, `#!/bin/bash\ntouch "${marker}"\n`);
  chmodSync(fetch, 0o755);
  chmodSync(activate, 0o755);

  const script = command
    .replace("/usr/local/bin/open-inspect-fetch-config", fetch)
    .replace("/opt/open-inspect/deploy.sh", activate);
  assert.notEqual(script, command, "the payload no longer names the paths this stubs");

  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { status: result.status, activated: existsSync(marker) };
}

test("a configuration fetch that fails never reaches the activation", () => {
  // The failure this rules out is silent. Run Command reports the status of the
  // last command it ran, so a fetch that fails ahead of an activation that
  // succeeds reports Success -- and that activation would bring up the `.env`
  // already on the instance, naming the previous image. The health check passes,
  // because the previous image is the one that was working; the deploy reports
  // the image it never fetched; nothing rolls back, because nothing looks wrong.
  const run = runDeploy({ previous: OLD, image: NEW });
  const [command] = JSON.parse(run.parameters).commands;

  const failed = runRemoteCommand(command, { fetchExits: 1 });
  assert.equal(failed.activated, false, "the activation must not run after a failed fetch");
  assert.notEqual(failed.status, 0, "and the command must report the fetch's failure");

  // The other half: the chain has to still activate when the fetch works.
  const ok = runRemoteCommand(command, { fetchExits: 0 });
  assert.equal(ok.activated, true);
  assert.equal(ok.status, 0);
});
