import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createCli, runCli, validateHttpUrl } from "./cli.js";
import { ConfigStore } from "./config-store.js";
import type { CredentialStore } from "./credential-store.js";

const credential = `oi_cli_${"c".repeat(64)}`;

describe("CLI commands", () => {
  it("aborts before exchange when device authorization recovery cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory, {
      credentialStore: {
        kind: "native",
        get: vi.fn(),
        set: vi.fn().mockRejectedValue(new Error("keyring locked")),
        delete: vi.fn(),
      } satisfies CredentialStore,
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json(
        {
          deviceSecret: "d".repeat(64),
          userCode: "ABCD-EFGH",
          verificationUrl: "https://web.example.com/cli/authorize",
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 1,
        },
        { status: 201 }
      )
    );

    await expect(
      createCli({ store, fetch }).parseAsync([
        "node",
        "oi",
        "login",
        "--no-browser",
        "--url",
        "https://api.example.com",
      ])
    ).rejects.toThrow("keyring locked");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drains persisted device authorization recovery before starting a new login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.stageDeviceAuthorization({
      url: "https://old.example.com",
      contextName: "old",
      deviceSecret: "d".repeat(64),
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }));

    await expect(
      createCli({ store, fetch }).parseAsync([
        "node",
        "oi",
        "login",
        "--no-browser",
        "--url",
        "https://new.example.com",
      ])
    ).rejects.toThrow("503");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://old.example.com/external/v1/cli/device-authorizations/revoke"
    );
    expect((await store.read()).pendingDeviceAuthorizations).toHaveLength(1);
  });

  it("persists only the final credential after device authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    const deviceSecret = "d".repeat(64);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            deviceSecret,
            userCode: "ABCD-EFGH",
            verificationUrl: "https://web.example.com/cli/authorize",
            expiresAt: Date.now() + 60_000,
            pollIntervalMs: 1,
          },
          { status: 201 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "authorized",
          credential,
          credentialId: "credential-1",
          expiresAt: Date.now() + 60_000,
        })
      );
    const stdout: string[] = [];
    const stderr: string[] = [];

    await createCli({
      store,
      fetch,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    }).parseAsync([
      "node",
      "oi",
      "login",
      "--no-browser",
      "--url",
      "https://api.example.com/",
      "--context",
      "work",
    ]);

    const contents = await readFile(store.filePath, "utf8");
    expect(contents).not.toContain(credential);
    expect(contents).not.toContain(deviceSecret);
    expect((await store.getActiveContext()).name).toBe("work");
    expect(stderr.join("")).toContain("ABCD-EFGH");
    expect(stdout.join("")).not.toContain(credential);
  });

  it("passes bounded list pagination and exposes the continuation offset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://api.example.com",
      credential,
      expiresAt: Date.now() + 60_000,
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ sessions: [], hasMore: true, continuationOffset: 75 }));
    const stdout: string[] = [];

    await createCli({ store, fetch, stdout: (value) => stdout.push(value) }).parseAsync([
      "node",
      "oi",
      "--output",
      "json",
      "session",
      "list",
      "--limit",
      "25",
      "--offset",
      "50",
    ]);

    expect(JSON.parse(stdout.join(""))).toEqual({
      sessions: [],
      hasMore: true,
      continuationOffset: 75,
    });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).search).toBe("?limit=25&offset=50");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${credential}`
    );
  });

  it("prints event journal tombstones without rewriting their order or shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://api.example.com",
      credential,
      expiresAt: Date.now() + 60_000,
    });
    const page = {
      changes: [
        { kind: "delete", revision: 10, eventId: "old-name" },
        {
          kind: "upsert",
          revision: 11,
          event: {
            id: "new-name",
            type: "token",
            messageId: null,
            createdAt: 1,
            data: { text: "renamed" },
          },
        },
      ],
      checkpoint: 11,
      hasMore: false,
    };
    const stdout: string[] = [];

    await createCli({
      store,
      fetch: vi.fn().mockResolvedValue(Response.json(page)),
      stdout: (value) => stdout.push(value),
    }).parseAsync(["node", "oi", "--output", "json", "session", "events", "s1"]);

    expect(JSON.parse(stdout.join(""))).toEqual(page);
  });

  it("preserves the local credential when remote logout can be retried", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://api.example.com",
      credential,
      expiresAt: Date.now() + 60_000,
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }));

    await expect(createCli({ store, fetch }).parseAsync(["node", "oi", "logout"])).rejects.toThrow(
      "503"
    );
    await expect(store.getActiveContext()).resolves.toMatchObject({ credential });
  });

  it.each([429, 500])("keeps logout retryable after HTTP %s", async (status) => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://api.example.com",
      credential,
      expiresAt: Date.now() + 60_000,
    });

    await expect(
      createCli({
        store,
        fetch: vi.fn().mockResolvedValue(Response.json({ error: "retry" }, { status })),
      }).parseAsync(["node", "oi", "logout"])
    ).rejects.toThrow(String(status));
    await expect(store.getActiveContext()).resolves.toMatchObject({ credential });
  });

  it("keeps logout retryable after a transport failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://api.example.com",
      credential,
      expiresAt: Date.now() + 60_000,
    });

    await expect(
      createCli({
        store,
        fetch: vi.fn().mockRejectedValue(new TypeError("network down")),
      }).parseAsync(["node", "oi", "logout"])
    ).rejects.toMatchObject({ kind: "transport" });
    await expect(store.getActiveContext()).resolves.toMatchObject({ credential });
  });

  it.each([401, 404, 410])(
    "removes the local credential when logout proves it invalid with %s",
    async (status) => {
      const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
      const store = new ConfigStore(directory);
      await store.saveContext("default", {
        url: "https://api.example.com",
        credential,
        expiresAt: Date.now() + 60_000,
      });

      await createCli({
        store,
        fetch: vi.fn().mockResolvedValue(Response.json({ error: "invalid" }, { status })),
      }).parseAsync(["node", "oi", "logout"]);

      await expect(store.getActiveContext()).rejects.toThrow("Not logged in");
    }
  );

  it("generates and reports an idempotency key for a one-shot create command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://api.example.com",
      credential,
      expiresAt: Date.now() + 60_000,
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ sessionId: "session-1", status: "created" }, { status: 201 })
      );
    const stdout: string[] = [];

    await createCli({ store, fetch, stdout: (value) => stdout.push(value) }).parseAsync([
      "node",
      "oi",
      "--output",
      "json",
      "session",
      "create",
      "--title",
      "Test",
      "--model",
      "openai/gpt-5.6-sol",
    ]);

    const output = JSON.parse(stdout.join(""));
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(output.idempotencyKey).toBe(request.idempotencyKey);
    expect(output.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(request).not.toHaveProperty("reasoningEffort");
  });

  it.each([
    ["create", "idempotencyKey", "--idempotency-key"],
    ["prompt", "clientRequestId", "--client-request-id"],
  ] as const)(
    "reports the recoverable %s request ID after a post-dispatch failure",
    async (operation, field, flag) => {
      const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
      const store = new ConfigStore(directory);
      await store.saveContext("default", {
        url: "https://api.example.com",
        credential,
        expiresAt: Date.now() + 60_000,
      });
      const stderr: string[] = [];
      const explicit = operation === "prompt" ? "caller-retry-id" : undefined;
      const args =
        operation === "create"
          ? [
              "session",
              "create",
              "--title",
              "Test",
              "--model",
              "openai/gpt-5.6-sol",
              "--reasoning",
              "high",
            ]
          : ["session", "prompt", "s1", "--content", "Continue", flag, explicit!];

      await expect(
        runCli(["node", "oi", "--output", "json", ...args], {
          store,
          fetch: vi.fn().mockRejectedValue(new TypeError("socket closed")),
          stderr: (value) => stderr.push(value),
        })
      ).rejects.toThrow();

      const envelope = JSON.parse(stderr.join(""));
      expect(envelope.error.kind).toBe("transport");
      expect(envelope.error.context[field]).toEqual(
        explicit ?? expect.stringMatching(/^[0-9a-f-]{36}$/)
      );
    }
  );

  it("prints a generated idempotency key after a post-dispatch text failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://api.example.com",
      credential,
      expiresAt: Date.now() + 60_000,
    });
    const stderr: string[] = [];
    const fetch = vi.fn().mockRejectedValue(new TypeError("socket closed"));

    await expect(
      runCli(
        [
          "node",
          "oi",
          "session",
          "create",
          "--title",
          "Test",
          "--model",
          "openai/gpt-5.6-sol",
          "--reasoning",
          "high",
        ],
        { store, fetch, stderr: (value) => stderr.push(value) }
      )
    ).rejects.toThrow();

    const requestId = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).idempotencyKey;
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("error:");
    expect(stderr[0]).toContain(`"idempotencyKey":"${requestId}"`);
  });

  it.each([
    ["text", ["session", "create", "--unknown"]],
    ["json", ["session", "create"]],
    ["stream-json", ["session", "create", "--unknown"]],
  ] as const)("routes Commander failures through one %s error envelope", async (format, args) => {
    const stderr: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await expect(
        runCli(["node", "oi", "--output", format, ...args], {
          stderr: (value) => stderr.push(value),
        })
      ).rejects.toMatchObject({ name: "CommanderError" });
    } finally {
      exit.mockRestore();
    }

    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
    if (format === "text") {
      expect(stderr[0]).toMatch(/^error: \{"kind":"validation"/);
    } else {
      expect(JSON.parse(stderr[0]!)).toMatchObject({ error: { kind: "validation" } });
    }
    expect(stderr[0]!.match(/unknown option|required option/g)).toHaveLength(1);
  });

  it("uses structured errors with Commander's inline output option syntax", async () => {
    const stderr: string[] = [];

    await expect(
      runCli(["node", "oi", "--output=json", "session", "create"], {
        stderr: (value) => stderr.push(value),
      })
    ).rejects.toMatchObject({ name: "CommanderError" });

    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toMatchObject({ error: { kind: "validation" } });
  });

  it("rejects non-HTTP verification URLs and passes metacharacters as URL data", async () => {
    expect(() => validateHttpUrl("javascript:alert(1)", "Verification URL")).toThrow(
      "HTTP or HTTPS"
    );
    expect(() => validateHttpUrl("https://user:pass@example.com", "Verification URL")).toThrow(
      "credentials"
    );
    expect(validateHttpUrl("https://example.com/verify?code=A&B=%26calc.exe")).toBe(
      "https://example.com/verify?code=A&B=%26calc.exe"
    );
  });

  it.each([
    ["javascript:alert(1)", false],
    ["https://example.com/verify?code=A&B=%26calc.exe", true],
  ] as const)("validates verification URL %s before calling the opener", async (url, opens) => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            deviceSecret: "d".repeat(64),
            userCode: "ABCD-EFGH",
            verificationUrl: url,
            expiresAt: Date.now() + 60_000,
            pollIntervalMs: 1,
          },
          { status: 201 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "authorized",
          credential,
          credentialId: "credential-1",
          expiresAt: Date.now() + 60_000,
        })
      );

    await createCli({
      store: new ConfigStore(directory),
      fetch,
      openUrl,
      stdout: vi.fn(),
      stderr: vi.fn(),
    }).parseAsync(["node", "oi", "login", "--url", "https://api.example.com"]);

    if (opens) expect(openUrl).toHaveBeenCalledWith(url);
    else expect(openUrl).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects login context %s before starting authorization",
    async (name) => {
      const fetch = vi.fn<typeof globalThis.fetch>();

      await expect(
        createCli({ fetch }).parseAsync([
          "node",
          "oi",
          "login",
          "--url",
          "https://api.example.com",
          "--context",
          name,
        ])
      ).rejects.toMatchObject({ kind: "validation" });
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});
