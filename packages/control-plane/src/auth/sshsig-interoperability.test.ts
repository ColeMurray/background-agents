import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { signGitPayloadWithOpenSshEd25519PrivateKey } from "./openssh-ed25519";

const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6QAAAKAVa6SnFWuk
pwAAAAtzc2gtZWQyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6Q
AAAEDu3j73XlXgmmJ6DeqA0/0I1EGPhOmMnk/be7rZrpUxDBaM0ggz8RWOz0lq3xs+vNPv
nuWs0SS30txpSJTb357pAAAAGXRlc3Qtc2lnbmluZ0BvcGVuLWluc3BlY3QBAgME
-----END OPENSSH PRIVATE KEY-----`;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Git SSHSIG OpenSSH interoperability", () => {
  it("produces armor accepted by stock ssh-keygen", async () => {
    const payload = new TextEncoder().encode("tree abcdef\n\ninteroperability\n");
    const result = await signGitPayloadWithOpenSshEd25519PrivateKey(PRIVATE_KEY, payload);
    const directory = mkdtempSync(join(tmpdir(), "oi-sshsig-"));
    temporaryDirectories.push(directory);
    const allowedSigners = join(directory, "allowed-signers");
    const signature = join(directory, "signature");
    writeFileSync(allowedSigners, `open-inspect@example.com ${result.publicKey}\n`);
    writeFileSync(signature, result.armoredSignature);

    const output = execFileSync(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowedSigners,
        "-I",
        "open-inspect@example.com",
        "-n",
        "git",
        "-s",
        signature,
      ],
      { input: payload, encoding: "utf8" }
    );

    expect(output).toContain('Good "git" signature');
  });
});
