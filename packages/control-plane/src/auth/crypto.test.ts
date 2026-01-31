import { describe, it, expect } from "vitest";
import { encryptToken, decryptToken, generateEncryptionKey, generateId, hashToken } from "./crypto";

describe("crypto", () => {
  describe("generateEncryptionKey", () => {
    it("generates a base64-encoded 32-byte key", () => {
      const key = generateEncryptionKey();

      // Decode and verify length
      const decoded = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(decoded.length).toBe(32);
    });

    it("generates unique keys each time", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();

      expect(key1).not.toBe(key2);
    });
  });

  describe("generateId", () => {
    it("generates a hex string of default length (16 bytes = 32 chars)", () => {
      const id = generateId();

      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it("generates a hex string of specified length", () => {
      const id8 = generateId(8);
      const id32 = generateId(32);

      expect(id8).toMatch(/^[0-9a-f]{16}$/);
      expect(id32).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique IDs each time", () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).not.toBe(id2);
    });
  });

  describe("encryptToken / decryptToken", () => {
    it("encrypts and decrypts a token successfully", async () => {
      const key = generateEncryptionKey();
      const originalToken = "gho_abc123xyz";

      const encrypted = await encryptToken(originalToken, key);
      const decrypted = await decryptToken(encrypted, key);

      expect(decrypted).toBe(originalToken);
    });

    it("produces different ciphertext each time (random IV)", async () => {
      const key = generateEncryptionKey();
      const token = "gho_abc123xyz";

      const encrypted1 = await encryptToken(token, key);
      const encrypted2 = await encryptToken(token, key);

      // Same plaintext should produce different ciphertext due to random IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same value
      expect(await decryptToken(encrypted1, key)).toBe(token);
      expect(await decryptToken(encrypted2, key)).toBe(token);
    });

    it("handles empty string", async () => {
      const key = generateEncryptionKey();

      const encrypted = await encryptToken("", key);
      const decrypted = await decryptToken(encrypted, key);

      expect(decrypted).toBe("");
    });

    it("handles long tokens", async () => {
      const key = generateEncryptionKey();
      const longToken = "a".repeat(10000);

      const encrypted = await encryptToken(longToken, key);
      const decrypted = await decryptToken(encrypted, key);

      expect(decrypted).toBe(longToken);
    });

    it("handles special characters and unicode", async () => {
      const key = generateEncryptionKey();
      const specialToken = "token_with_special_chars!@#$%^&*()_+-=[]{}|;':\",./<>?`~";
      const unicodeToken = "token_with_unicode_🔐🔑";

      const encryptedSpecial = await encryptToken(specialToken, key);
      const encryptedUnicode = await encryptToken(unicodeToken, key);

      expect(await decryptToken(encryptedSpecial, key)).toBe(specialToken);
      expect(await decryptToken(encryptedUnicode, key)).toBe(unicodeToken);
    });

    it("fails to decrypt with wrong key", async () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      const token = "gho_abc123xyz";

      const encrypted = await encryptToken(token, key1);

      // Decryption with wrong key should throw
      await expect(decryptToken(encrypted, key2)).rejects.toThrow();
    });

    it("fails to decrypt corrupted ciphertext", async () => {
      const key = generateEncryptionKey();
      const token = "gho_abc123xyz";

      const encrypted = await encryptToken(token, key);

      // Corrupt the ciphertext by changing a character
      const corrupted = encrypted.slice(0, -5) + "XXXXX";

      await expect(decryptToken(corrupted, key)).rejects.toThrow();
    });
  });

  describe("hashToken", () => {
    it("produces a 64-character hex string (SHA-256)", async () => {
      const hash = await hashToken("test_token");

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic (same input = same output)", async () => {
      const hash1 = await hashToken("test_token");
      const hash2 = await hashToken("test_token");

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different inputs", async () => {
      const hash1 = await hashToken("token1");
      const hash2 = await hashToken("token2");

      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", async () => {
      const hash = await hashToken("");

      // SHA-256 of empty string is a known value
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });
});
