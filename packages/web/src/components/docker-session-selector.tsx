"use client";

import useSWR from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";

/** The server remains authoritative; this only advertises deployment availability. */
export function DockerSessionSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  disabled?: boolean;
}) {
  const { data } = useSWR("/api/session-capabilities", async () => {
    const response = await browserApiFetch("/api/session-capabilities");
    if (!response.ok) return { dockerAvailable: false };
    const result: unknown = await response.json();
    return {
      dockerAvailable:
        !!result &&
        typeof result === "object" &&
        "dockerAvailable" in result &&
        result.dockerAvailable === true,
    };
  });
  return (
    <label className="block text-sm text-muted-foreground">
      Sandbox execution
      <select
        aria-label="Sandbox execution"
        className="ml-2 rounded border border-border bg-background px-2 py-1"
        disabled={disabled}
        value={value === undefined ? "inherit" : String(value)}
        onChange={(event) =>
          onChange(event.target.value === "inherit" ? undefined : event.target.value === "true")
        }
      >
        <option value="inherit">Use inherited setting</option>
        <option value="false">Standard (gVisor on Modal)</option>
        <option value="true" disabled={!data?.dockerAvailable}>
          Docker (Modal VM){!data?.dockerAvailable ? " — unavailable" : ""}
        </option>
      </select>
    </label>
  );
}
