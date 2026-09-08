import { SESSION_LIST_CURRENT_USER } from "@open-inspect/shared/session-list-query";
import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import { error } from "./shared";

export function parseCreatedByFilters(
  values: readonly string[],
  currentUserId: string | null
): string[] | Response {
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const userId = value === SESSION_LIST_CURRENT_USER ? currentUserId : value;

    if (!isCanonicalUserId(userId)) {
      return error("Invalid createdBy", 400);
    }

    if (!seen.has(userId)) {
      seen.add(userId);
      userIds.push(userId);
    }
  }

  return userIds;
}
