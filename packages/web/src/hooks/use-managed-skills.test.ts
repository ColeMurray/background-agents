import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidateSkillCatalogPage, SKILL_CATALOG_PAGE_SIZE } from "./use-managed-skills";

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
  it.each([
    ["initial", null, `/api/skills?limit=${SKILL_CATALOG_PAGE_SIZE}`],
    ["later", "first-skill", `/api/skills?limit=${SKILL_CATALOG_PAGE_SIZE}&cursor=first-skill`],
  ])("clears the aggregate cache and refreshes the %s page", async (_page, cursor, expectedKey) => {
    await revalidateSkillCatalogPage(cursor);

    expect(mutateSWRMock).toHaveBeenCalledWith("/api/skills", undefined, { revalidate: false });
    expect(mutateSWRMock).toHaveBeenCalledWith(expectedKey);
  });
});
