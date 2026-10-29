import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as vercelMain } from "../../../vercel-infra/src/main";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  verify: vi.fn(),
  build: vi.fn(),
  listVercel: vi.fn(),
}));
vi.mock("../../../sandbox-images/src/node", () => ({
  packImage: () => ({
    directory: "/unused",
    plan: { buildHash: "a".repeat(64), runtimeEnv: {}, runtimeVersion: "v1" },
    files: [],
  }),
  writeBuildResult: mocks.record,
}));
vi.mock("./providers/vercel/client", () => ({
  createVercelSandboxClient: () => ({ listSnapshots: mocks.listVercel }),
}));
vi.mock("../../../vercel-infra/src/base-snapshot", () => ({
  verifyVercelSnapshot: mocks.verify,
  buildVercelBaseSnapshot: mocks.build,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENINSPECT_REPO_ROOT", "/unused");
  vi.stubEnv("OPENINSPECT_IMAGE_CANDIDATE", "candidate");
  vi.stubEnv("VERCEL_TOKEN", "test");
  vi.stubEnv("VERCEL_PROJECT_ID", "project");
  mocks.listVercel.mockResolvedValue([{ id: "snap-retained", status: "created" }]);
  mocks.verify.mockResolvedValue({ passed: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("native candidate retry", () => {
  it("reverifies an existing Vercel candidate and regenerates its record", async () => {
    await vercelMain();
    expect(mocks.verify).toHaveBeenCalledWith(expect.anything(), "snap-retained");
    expect(mocks.record).toHaveBeenCalledWith("snap-retained");
    expect(mocks.build).not.toHaveBeenCalled();
  });
  it("does not publish a Vercel candidate with failed service checks", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("service check failed"));
    await expect(vercelMain()).rejects.toThrow("service check failed");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });
});
