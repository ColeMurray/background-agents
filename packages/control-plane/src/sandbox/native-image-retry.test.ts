import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as vercelMain } from "../../../vercel-infra/src/main";
import { main as opencomputerMain } from "../../../opencomputer-infra/src/build-template";

const mocks = vi.hoisted(() => {
  const image: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ["env", "runCommands", "addLocalFile", "workdir", "builderMemory"])
    image[name] = vi.fn(() => image);
  return {
    image,
    record: vi.fn(),
    verify: vi.fn(),
    build: vi.fn(),
    listVercel: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    restore: vi.fn(),
    exec: vi.fn(),
    kill: vi.fn(),
  };
});
vi.mock("../../../sandbox-images/src/node", () => ({
  packImage: () => ({
    directory: "/unused",
    plan: { recipeDigest: "a".repeat(64), inputs: [], runtimeEnv: {}, runtimeVersion: "v1" },
  }),
  recordCandidate: mocks.record,
}));
vi.mock("./providers/vercel/client", () => ({
  createVercelSandboxClient: () => ({ listSnapshots: mocks.listVercel }),
}));
vi.mock("../../../vercel-infra/src/base-snapshot", () => ({
  verifyVercelSnapshot: mocks.verify,
  buildVercelBaseSnapshot: mocks.build,
}));
vi.mock("@opencomputer/sdk/node", () => ({
  Image: { base: () => mocks.image },
  Sandbox: { create: mocks.restore },
  Snapshots: class {
    list = mocks.list;
    get = mocks.get;
    create = mocks.create;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENINSPECT_REPO_ROOT", "/unused");
  vi.stubEnv("OPENINSPECT_IMAGE_CANDIDATE", "candidate");
  vi.stubEnv("OPENINSPECT_VERIFY_REFERENCE", "");
  vi.stubEnv("OPENINSPECT_EXPECTED_RECIPE", "");
  vi.stubEnv("VERCEL_TOKEN", "test");
  vi.stubEnv("VERCEL_PROJECT_ID", "project");
  vi.stubEnv("OPENCOMPUTER_API_KEY", "test");
  mocks.listVercel.mockResolvedValue([{ id: "snap-retained", status: "created" }]);
  mocks.verify.mockResolvedValue({ passed: true });
  mocks.list.mockResolvedValue([{ name: "candidate" }]);
  mocks.get.mockResolvedValue({ status: "ready" });
  mocks.restore.mockResolvedValue({ exec: { run: mocks.exec }, kill: mocks.kill });
  mocks.exec.mockResolvedValue({ exitCode: 0, stdout: '{"passed":true}' });
});
afterEach(() => vi.unstubAllEnvs());

describe("native candidate retry", () => {
  it("reverifies an existing Vercel candidate and regenerates its record", async () => {
    await vercelMain();
    expect(mocks.verify).toHaveBeenCalledWith(expect.anything(), "snap-retained", "a".repeat(64));
    expect(mocks.record).toHaveBeenCalledWith(
      "/unused",
      "vercel",
      expect.any(String),
      "snap-retained",
      { passed: true }
    );
    expect(mocks.build).not.toHaveBeenCalled();
  });
  it("does not publish a Vercel candidate with mismatched recipe evidence", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("recipe mismatch"));
    await expect(vercelMain()).rejects.toThrow("recipe mismatch");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });
  it("restores and reverifies an existing OpenComputer candidate", async () => {
    await opencomputerMain();
    expect(mocks.get).toHaveBeenCalledWith("candidate");
    expect(mocks.exec).toHaveBeenCalledWith(
      expect.stringContaining(`--expected-recipe ${"a".repeat(64)}`),
      expect.anything()
    );
    expect(mocks.record).toHaveBeenCalledWith(
      "/unused",
      "opencomputer",
      expect.any(String),
      "candidate",
      { passed: true }
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.kill).toHaveBeenCalledOnce();
  });
  it("does not publish failed OpenComputer verification and releases the sandbox", async () => {
    mocks.exec.mockResolvedValueOnce({ exitCode: 1, stderr: "recipe mismatch" });
    await expect(opencomputerMain()).rejects.toThrow("recipe mismatch");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.kill).toHaveBeenCalledOnce();
  });
});
