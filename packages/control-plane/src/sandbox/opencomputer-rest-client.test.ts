import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenComputerRestClient } from "./opencomputer-rest-client";

const config = {
  apiUrl: "https://api.opencomputer.dev",
  apiKey: "test-key",
  template: "openinspect-runtime-abc",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// OpenComputer launches the runtime via `exec`, whose shell does NOT inherit the
// image's baked env. SANDBOX_VERSION therefore has to be re-exported in the exec
// command — otherwise the runtime reports an empty version and the image-build
// build-complete callback is rejected by the runtime-version floor check.
describe("OpenComputerRestClient runtime SANDBOX_VERSION export", () => {
  it("startRuntime exports SANDBOX_VERSION to the exec shell", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ exitCode: 0, stdout: "123", stderr: "" }));

    await client.startRuntime("sb-1");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/sandboxes/sb-1/exec/run");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.args[1]).toContain("SANDBOX_VERSION=v54-opencode-1-17-18");
  });

  it("runRuntimeForeground (image build path) exports SANDBOX_VERSION", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));

    await client.runRuntimeForeground("sb-1", 60);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.args[1]).toContain("SANDBOX_VERSION=v54-opencode-1-17-18");
  });
});
