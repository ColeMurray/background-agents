import useSWR from "swr";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "@/lib/theme";

export const USER_THEME_PREFERENCES_KEY = "/api/user-preferences";

interface UserThemePreferenceResponse {
  theme?: string;
}

export function useUserThemePreference() {
  const { data, error, isLoading } = useSWR<UserThemePreferenceResponse>(
    USER_THEME_PREFERENCES_KEY
  );

  const theme: ThemeId = data?.theme && isThemeId(data.theme) ? data.theme : DEFAULT_THEME_ID;

  return {
    theme,
    loading: isLoading,
    error,
  };
}

export async function updateUserThemePreference(theme: ThemeId): Promise<void> {
  const response = await fetch(USER_THEME_PREFERENCES_KEY, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to update theme preference");
  }
}
