import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidateSkillCatalogPage } from "./use-managed-skills";

const { mutateSWRMock } = vi.hoisted(() => ({ mutateSWRMock: vi.fn() }));

vi.mock("swr", () => ({
  default: vi.fn(),
  mutate: mutateSWRMock,
}));

beforeEach(() => {
  mutateSWRMock.mockReset();
  mutateSWRMock.mockResolvedValue(undefined);
});

describe("revalidateSkillCatalogPage", () => {
  it("clears the aggregate cache without fetching it and refreshes the active page", async () => {
    await revalidateSkillCatalogPage("first-skill");

    expect(mutateSWRMock).toHaveBeenCalledWith("/api/skills", undefined, { revalidate: false });
    expect(mutateSWRMock).toHaveBeenCalledWith("/api/skills?limit=25&cursor=first-skill");
  });
});
