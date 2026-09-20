import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { copyBotSecret } from "./copy-bot-secret-to-ssm.mjs";

const key = "a".repeat(64);
const args = ["slack", "/isolated-cloudflare-state", "/open-inspect/staging", "--execute"];

for (const bot of ["slack", "linear"]) {
  test(`copies the exact ${bot} receiver key without putting it in argv, then removes the private file`, () => {
    let request;
    let calls = 0;
    const parameter = copyBotSecret([bot, ...args.slice(1)], (command, argv, options) => {
      calls++;
      assert(!JSON.stringify(argv).includes(key));
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      if (command === "terraform") {
        assert.deepEqual(argv, [
          "-chdir=/isolated-cloudflare-state",
          "output",
          "-raw",
          `service_auth_secret_${bot}_bot`,
        ]);
        assert.equal(options.env.TF_LOG, "OFF");
        return { status: 0, stdout: key };
      }
      assert.equal(command, "aws");
      assert.deepEqual(argv.slice(0, 3), ["ssm", "put-parameter", "--cli-input-json"]);
      request = argv[3].slice("file://".length);
      assert.equal(statSync(request).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(request)).mode & 0o777, 0o700);
      assert.deepEqual(JSON.parse(readFileSync(request, "utf8")), {
        Name: `/open-inspect/staging/SERVICE_AUTH_SECRET_${bot.toUpperCase()}_BOT`,
        Value: key,
        Type: "SecureString",
        Overwrite: true,
      });
      return { status: 0, stdout: "ok" };
    });
    assert.equal(calls, 2);
    assert.equal(parameter, `/open-inspect/staging/SERVICE_AUTH_SECRET_${bot.toUpperCase()}_BOT`);
    assert(!existsSync(dirname(request)));
  });
}

for (const output of [
  { status: 1, stdout: key },
  { status: 0, stdout: "" },
  { status: 0, stdout: "null" },
  { status: 0, stdout: "CHANGE_ME_SLACK" },
  { status: 0, stdout: `${key}\n` },
]) {
  test(`failed or invalid export fails closed: ${output.status}/${output.stdout.length}`, () => {
    let calls = 0;
    assert.throws(
      () =>
        copyBotSecret(args, (command) => {
          calls++;
          assert.equal(command, "terraform");
          return output;
        }),
      /AWS was not changed/
    );
    assert.equal(calls, 1);
  });
}

test("AWS failure removes the file and never includes captured CLI output in the error", () => {
  let request;
  assert.throws(
    () =>
      copyBotSecret(args, (command, argv) => {
        if (command === "terraform") return { status: 0, stdout: key };
        request = argv[3].slice("file://".length);
        return { status: 1, stdout: key, stderr: key };
      }),
    (error) => !error.message.includes(key) && /did not confirm success/.test(error.message)
  );
  assert(!existsSync(dirname(request)));
});

test("requires an explicit bot, target prefix and execution confirmation", () => {
  for (const invalid of [
    args.slice(0, 3),
    ["github", ...args.slice(1)],
    ["slack", args[1], "/", "--execute"],
  ]) {
    assert.throws(
      () => copyBotSecret(invalid, () => assert.fail("must not invoke a CLI")),
      /Usage:/
    );
  }
});

test("sensitive outputs reference exactly the keys bound to the receivers", () => {
  const read = (file) =>
    readFileSync(new URL(`../terraform/environments/production/${file}`, import.meta.url), "utf8");
  for (const bot of ["slack", "linear"]) {
    const output = read("outputs.tf").match(
      new RegExp(`output "service_auth_secret_${bot}_bot" \\{([\\s\\S]*?)\\n\\}`)
    )?.[1];
    assert(output);
    assert.match(output, /sensitive\s*=\s*true/);
    assert(
      output.includes(
        `var.enable_${bot}_bot ? random_password.service_auth_secret_${bot}_bot.result : null`
      )
    );
    assert(
      read(`workers-${bot}.tf`).includes(
        `SERVICE_AUTH_SECRET${bot === "slack" ? "  " : "   "}= { value = random_password.service_auth_secret_${bot}_bot.result }`
      )
    );
  }
});
