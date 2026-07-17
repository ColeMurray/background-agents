import { describe, expect, it } from "vitest";

import {
  signGitPayloadWithOpenSshEd25519PrivateKey,
  validateOpenSshEd25519PrivateKey,
} from "../../src/auth/openssh-ed25519";
import { createGitSshSigSignedData } from "../../src/auth/sshsig";

const VALID_ED25519_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6QAAAKAVa6SnFWuk
pwAAAAtzc2gtZWQyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6Q
AAAEDu3j73XlXgmmJ6DeqA0/0I1EGPhOmMnk/be7rZrpUxDBaM0ggz8RWOz0lq3xs+vNPv
nuWs0SS30txpSJTb357pAAAAGXRlc3Qtc2lnbmluZ0BvcGVuLWluc3BlY3QBAgME
-----END OPENSSH PRIVATE KEY-----`;

const ENCRYPTED_ED25519_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCHCV6jRu
8OgBjE/nuhuHlOAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIP4UcazmEXqpDVnI
JOZxo8JTdR3ARtWtSuvvBDljnFtQAAAAoC84wLONdJcaSN83zkMr+jOtm72/UlzaZm9xAr
vShT/AvGXxQAlGibJDhIUdEHGifK/IrcoVgpo0xNHN5O8sRiuyYjvHrD6ehx/ZKgqaYYH8
0gfwBkQE4QwJTXXYmz5TLRbpQvhr/D3uw0s9wO7ezWOuZoOjzCV+nEHd3M5bdZShzDynSk
7QSic/zN1lFGrZ4ytSTDmXKAo0fsgcjfsDrxo=
-----END OPENSSH PRIVATE KEY-----`;

const RSA_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEAtxJLXSA6CQbEoyFic/hI8SCwpZ/PRhZa6BQCM9WJf9Yr5vysj2mz
S/2M0R/XBQVmZVxDvu2fpfKFyICRUm6wBzxrEOR96xMgzrA58T3hAIOl/jxq5zsbQ6HRSU
UyT3Z11yOGKZ6MhQhXOMMpWl9oF5Q8Cw5C9KyVxEvOiNSewBTmQsplm9q6N/ja95re21LG
NcW3WWKcLjTW4D4e8PMEQm2e6X1Kcd9F+9EKO0ntRw2JoEBZrku4WCQIy6Q+3dFZvXS1Ss
9wFCmo8i8w3j9h6CcgGY3gHZmGI5D6eaiIkFubGqKTg9mr3i+seUh5Jx0KR5KeqfMVvywJ
AFkAw2IVcQAAA9CDiZGOg4mRjgAAAAdzc2gtcnNhAAABAQC3EktdIDoJBsSjIWJz+EjxIL
Cln89GFlroFAIz1Yl/1ivm/KyPabNL/YzRH9cFBWZlXEO+7Z+l8oXIgJFSbrAHPGsQ5H3r
EyDOsDnxPeEAg6X+PGrnOxtDodFJRTJPdnXXI4YpnoyFCFc4wylaX2gXlDwLDkL0rJXES8
6I1J7AFOZCymWb2ro3+Nr3mt7bUsY1xbdZYpwuNNbgPh7w8wRCbZ7pfUpx30X70Qo7Se1H
DYmgQFmuS7hYJAjLpD7d0Vm9dLVKz3AUKajyLzDeP2HoJyAZjeAdmYYjkPp5qIiQW5saop
OD2aveL6x5SHknHQpHkp6p8xW/LAkAWQDDYhVxAAAAAwEAAQAAAQAzWedX3OVKiOJ5W7Dx
FLDpKiFCo/wRDc48EPi5L2mdOSchaLjClYSciSeJtWOr3eLmBaZfFOpWMxwBrMaWl8O6k+
D4YQ9M9BWcxGPMXm4RpdvW332hFLxGEUrSQZ2mGnVdfnJwlC+YVUmZ+2xLFD3vdz4MX9i6
Jvrvj9AEI5fQCtJrRpaRb3wScnM7jv2JBpO2QH6tKLYpZXoSehS6iK9hUU4Zlor+ifrqJk
2jDbC8s+edYvnw7ViZ8EJAYjQYacgLkmdLq3gyctEn1sUkGygHN+yFZEIs6riEvhnoJnLJ
3jxNCoZAdCEtZ4GBpQgz76p7CWcrvKy1FF+NXiKBU3edAAAAgCzR8IuGt6dfILzVxk2P1i
ruE63jEsauahnmXwvSrdZXiZXgMSbXeO8JfIfLP2hpJ6RVTWHAclO0BrNALoyv8eQ9Ozfg
W2Q4LBltoYR6z/ittFSlmY3869dOix2DMtu9eLC65Lb+WAE3GkONzxc4mg022BP6+FjkjQ
8o2Gnd21m9AAAAgQDzpnNq8R3lFwhtQhytIvmMm9hiR56W45Egq7ETZj2giuIT1OWvfOag
si73MICNniQ+XdSpWQhGtXri//wkmuzpvZpWvOuTSAoH+PjR4T2ijZ9EbyFPBsp6ZCqBje
7DZwQm0z90/3g4wAHO7MNzyK9AvGIHO01CkXaI9GsaT/lEdwAAAIEAwFnJqUUJNYZXIvfu
K9C3oeURg0fHZnN9Pen2Ls6+qlXRQ7Yt9IqJMLZHryyp7o/gpD3xNLM+07m85+ZcNrB9r4
1nVEozEy3ei2vEmL2jyZkPBs3FZ/o01pYEjNv04vHRlQPLEnGTS6+q5LuKN6tw4w9j3SS0
DQ7cqjtWY1iL91cAAAAVcnNhLXRlc3RAb3Blbi1pbnNwZWN0AQIDBAUG
-----END OPENSSH PRIVATE KEY-----`;

function decodeValidKey(): Uint8Array {
  const encoded = VALID_ED25519_PRIVATE_KEY.split("\n").slice(1, -1).join("");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

function encodeKey(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa(binary)}\n-----END OPENSSH PRIVATE KEY-----`;
}

function mutateDecodedKey(mutator: (bytes: Uint8Array) => void): string {
  const bytes = decodeValidKey();
  mutator(bytes);
  return encodeKey(bytes);
}

describe("OpenSSH Ed25519 private key validation", () => {
  it("derives the public key and SHA-256 fingerprint from a valid key", async () => {
    const result = await validateOpenSshEd25519PrivateKey(VALID_ED25519_PRIVATE_KEY);

    expect(result).toEqual({
      keyFormat: "ssh-ed25519",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaM0ggz8RWOz0lq3xs+vNPvnuWs0SS30txpSJTb357p",
      fingerprint: "SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM",
    });
  });

  it("accepts CRLF input without a final newline", async () => {
    const result = await validateOpenSshEd25519PrivateKey(
      VALID_ED25519_PRIVATE_KEY.replaceAll("\n", "\r\n")
    );

    expect(result.fingerprint).toBe("SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM");
  });

  it("rejects a private key larger than the secret-size limit", async () => {
    const oversizedKey = `${VALID_ED25519_PRIVATE_KEY}${"x".repeat(16_384)}`;

    await expect(validateOpenSshEd25519PrivateKey(oversizedKey)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Signing key exceeds 16384 bytes",
    });
  });

  it("rejects encrypted Ed25519 private keys", async () => {
    await expect(
      validateOpenSshEd25519PrivateKey(ENCRYPTED_ED25519_PRIVATE_KEY)
    ).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Encrypted OpenSSH private keys are not supported",
    });
  });

  it("rejects RSA private keys", async () => {
    await expect(validateOpenSshEd25519PrivateKey(RSA_PRIVATE_KEY)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Only Ed25519 signing keys are supported",
    });
  });

  it("reports malformed binary fields as a bounded validation error", async () => {
    const malformedKey = mutateDecodedKey((bytes) => {
      bytes[47] = 0xff;
    });

    await expect(validateOpenSshEd25519PrivateKey(malformedKey)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
    });
  });

  it("rejects containers that claim to hold multiple keys", async () => {
    const multipleKeyContainer = mutateDecodedKey((bytes) => {
      bytes[38] = 2;
    });

    await expect(validateOpenSshEd25519PrivateKey(multipleKeyContainer)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Expected exactly one unencrypted private key",
    });
  });

  it("rejects unequal private-key check integers", async () => {
    const invalidCheckValue = mutateDecodedKey((bytes) => {
      bytes[105] ^= 1;
    });

    await expect(validateOpenSshEd25519PrivateKey(invalidCheckValue)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Invalid OpenSSH private key check values",
    });
  });

  it("rejects invalid Ed25519 field lengths", async () => {
    const invalidPublicKeyLength = mutateDecodedKey((bytes) => {
      bytes[61] = 31;
    });

    await expect(validateOpenSshEd25519PrivateKey(invalidPublicKeyLength)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Invalid Ed25519 public key",
    });
  });

  it("rejects mismatched outer and inner public keys", async () => {
    const mismatchedPublicKey = mutateDecodedKey((bytes) => {
      bytes[62] ^= 1;
    });

    await expect(validateOpenSshEd25519PrivateKey(mismatchedPublicKey)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Inconsistent Ed25519 key material",
    });
  });

  it("cryptographically rejects a private seed that does not match the public key", async () => {
    const mismatchedPrivateSeed = mutateDecodedKey((bytes) => {
      bytes[161] ^= 1;
    });

    await expect(validateOpenSshEd25519PrivateKey(mismatchedPrivateSeed)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Inconsistent Ed25519 key material",
    });
  });

  it("rejects invalid deterministic padding", async () => {
    const invalidPadding = mutateDecodedKey((bytes) => {
      bytes[bytes.length - 1] = 0;
    });

    await expect(validateOpenSshEd25519PrivateKey(invalidPadding)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Invalid OpenSSH private key padding",
    });
  });

  it("rejects a private block with no deterministic padding", async () => {
    const bytes = decodeValidKey().slice(0, -4);
    bytes[97] = 156;
    const missingPadding = encodeKey(bytes);

    await expect(validateOpenSshEd25519PrivateKey(missingPadding)).rejects.toMatchObject({
      name: "OpenSshKeyValidationError",
      message: "Invalid OpenSSH private key padding",
    });
  });
});

describe("OpenSSH Ed25519 Git signing", () => {
  it("returns a complete armored SSHSIG that verifies against the configured key", async () => {
    const payload = new Uint8Array([0, 1, 2, 255, 10]);

    const result = await signGitPayloadWithOpenSshEd25519PrivateKey(
      VALID_ED25519_PRIVATE_KEY,
      payload
    );

    expect(result.fingerprint).toBe("SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM");
    expect(result.armoredSignature).toMatch(
      /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\n]+\n-----END SSH SIGNATURE-----\n$/
    );

    const sshsig = decodeArmor(result.armoredSignature);
    const reader = new TestBinaryReader(sshsig);
    expect(new TextDecoder().decode(reader.readBytes(6))).toBe("SSHSIG");
    expect(reader.readUint32()).toBe(1);
    const publicKeyBlob = reader.readString();
    expect(new TextDecoder().decode(reader.readString())).toBe("git");
    expect(reader.readString()).toHaveLength(0);
    expect(new TextDecoder().decode(reader.readString())).toBe("sha512");
    const signatureReader = new TestBinaryReader(reader.readString());
    expect(new TextDecoder().decode(signatureReader.readString())).toBe("ssh-ed25519");
    const rawSignature = signatureReader.readString();
    expect(signatureReader.remaining).toBe(0);
    expect(reader.remaining).toBe(0);

    const publicKeyReader = new TestBinaryReader(publicKeyBlob);
    expect(new TextDecoder().decode(publicKeyReader.readString())).toBe("ssh-ed25519");
    const rawPublicKey = publicKeyReader.readString();
    expect(publicKeyReader.remaining).toBe(0);
    const publicCryptoKey = await crypto.subtle.importKey(
      "raw",
      rawPublicKey,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        publicCryptoKey,
        rawSignature,
        await createGitSshSigSignedData(payload)
      )
    ).resolves.toBe(true);
  });
});

class TestBinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBytes(length: number): Uint8Array {
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readUint32(): number {
    const bytes = this.readBytes(4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  }

  readString(): Uint8Array {
    return this.readBytes(this.readUint32());
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}

function decodeArmor(armoredSignature: string): Uint8Array {
  const base64 = armoredSignature
    .replace("-----BEGIN SSH SIGNATURE-----", "")
    .replace("-----END SSH SIGNATURE-----", "")
    .replaceAll("\n", "");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
