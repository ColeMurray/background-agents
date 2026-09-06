// What `scripts/deploy-aws.sh` does when a deploy goes wrong.
//
// The rollback is the part that matters and the part nobody exercises by
// hand: it only runs when a deploy has already failed, which is exactly when
// nobody wants to be discovering that the rollback is broken too. So the AWS
// CLI and curl are replaced with stubs that record what was asked of them, and
// the health check is made to fail on demand.
//
// The stub `aws` keeps the deployed-image parameter in a file, and the stub
// `curl` fails while that file names the bad image -- so a rollback makes the
// service healthy again, the way it would in reality.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("./deploy-aws.sh", import.meta.url));

const AWS_STUB = `#!/bin/bash
# Stand-in for the AWS CLI. Only the calls deploy-aws.sh makes.
set -uo pipefail
state="$STUB_DIR/deployed"
log="$STUB_DIR/calls"
echo "aws $*" >>"$log"

case "$2" in
  get-parameter) cat "$state" ;;
  put-parameter)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--value" ]; then printf '%s' "$2" >"$state"; fi
      shift
    done
    ;;
  send-command)
    echo sent >>"$STUB_DIR/activations"
    echo "command-$(wc -l <"$STUB_DIR/activations" | tr -d ' ')"
    ;;
  get-command-invocation)
    case " $* " in
      *StandardOutputContent*) echo "remote output" ;;
      *) cat "$STUB_DIR/command_status" ;;
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
deployed="$(cat "$STUB_DIR/deployed")"
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
  goodChecks = 0,
  failOnProbe = 0,
}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-aws-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);

  writeFileSync(join(dir, "deployed"), previous);
  writeFileSync(join(dir, "bad_image"), badImage);
  writeFileSync(join(dir, "good_checks"), String(goodChecks));
  writeFileSync(join(dir, "fail_on_probe"), String(failOnProbe));
  writeFileSync(join(dir, "probes"), "");
  writeFileSync(join(dir, "command_status"), commandStatus);
  writeFileSync(join(dir, "activations"), "");
  writeFileSync(join(dir, "calls"), "");

  for (const [name, body] of [
    ["aws", AWS_STUB],
    ["curl", CURL_STUB],
  ]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }

  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_DIR: dir,
      AWS_REGION: "us-west-2",
      DEPLOYED_IMAGE_PARAMETER: "/open-inspect-staging/env/CONTROL_PLANE_IMAGE",
      INSTANCE_ID: "i-0123456789abcdef0",
      HEALTHCHECK_URL: "https://example.invalid/healthz",
      IMAGE_REF: image,
      // Compressed so the suite runs in seconds rather than minutes.
      COMMAND_POLL_SECONDS: "0",
      COMMAND_TIMEOUT_SECONDS: "5",
      HEALTH_INTERVAL_SECONDS: "0",
      HEALTH_TIMEOUT_SECONDS: "2",
      HEALTH_CONSECUTIVE: "2",
    },
  });

  const countLines = (name) => {
    const body = readFileSync(join(dir, name), "utf8").trim();
    return body === "" ? 0 : body.split("\n").length;
  };

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    deployed: readFileSync(join(dir, "deployed"), "utf8"),
    activations: countLines("activations"),
    probes: countLines("probes"),
  };
}

const OLD = "registry/control-plane:old";
const NEW = "registry/control-plane:new";

test("a healthy deploy leaves the new image deployed", () => {
  const run = runDeploy({ previous: OLD, image: NEW });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.deployed, NEW);
  assert.equal(run.activations, 1, "no rollback should have been attempted");
});

test("an image that never becomes healthy is rolled back, and the job still fails", () => {
  const run = runDeploy({ previous: OLD, image: NEW, badImage: NEW });

  assert.equal(run.deployed, OLD, "the previous image must be restored");
  assert.equal(run.activations, 2, "the rollback must be activated, not just written");
  assert.match(run.output, /rolled back to registry\/control-plane:old/);
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
