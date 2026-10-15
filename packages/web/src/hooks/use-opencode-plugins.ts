import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type {
  OpencodePlugin,
  OpencodePluginInput,
  OpencodePluginUpdate,
} from "@open-inspect/shared/types/opencode-plugins";

const KEY = "/api/opencode-plugins";
export function useOpencodePlugins() {
  const { data: session } = useAuthSession();
  const { data, isLoading, error, mutate } = useSWR<OpencodePlugin[]>(session ? KEY : null);
  return { plugins: data ?? [], loading: isLoading, error, mutate };
}
export function saveOpencodePlugin(input: OpencodePluginInput): Promise<void>;
export function saveOpencodePlugin(input: OpencodePluginUpdate, id: string): Promise<void>;
export async function saveOpencodePlugin(
  input: OpencodePluginInput | OpencodePluginUpdate,
  id?: string
): Promise<void> {
  const response = await browserApiFetch(id ? `${KEY}/${encodeURIComponent(id)}` : KEY, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Failed to save plugin");
  }
}
export async function deleteOpencodePlugin(id: string): Promise<void> {
  const response = await browserApiFetch(`${KEY}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Failed to delete plugin");
}
