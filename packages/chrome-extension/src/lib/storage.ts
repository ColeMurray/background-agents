import { STORAGE_KEYS, DEFAULT_WEB_APP_URL, DEFAULT_WS_URL } from "@/lib/constants";

export async function getWebAppUrl(): Promise<string> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.WEB_APP_URL);
  return (result[STORAGE_KEYS.WEB_APP_URL] as string) || DEFAULT_WEB_APP_URL;
}

export async function setWebAppUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.WEB_APP_URL]: url });
}

export async function getWsUrl(): Promise<string> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.WS_URL);
  return (result[STORAGE_KEYS.WS_URL] as string) || DEFAULT_WS_URL;
}

export async function setWsUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.WS_URL]: url });
}

export async function getLastSessionId(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LAST_SESSION_ID);
  return (result[STORAGE_KEYS.LAST_SESSION_ID] as string) || null;
}

export async function setLastSessionId(id: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SESSION_ID]: id });
}
