"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_SIZE = 16384;
const MAX_TOTAL_VALUE_SIZE = 65536;
const MAX_SECRETS_PER_REPO = 50;

const RESERVED_KEYS = new Set([
  "PYTHONUNBUFFERED",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "REPO_OWNER",
  "REPO_NAME",
  "GITHUB_APP_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "OPENCODE_CONFIG_CONTENT",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "LANG",
]);

type SecretRow = {
  id: string;
  key: string;
  value: string;
  existing: boolean;
};

function normalizeKey(value: string) {
  return value.trim().toUpperCase();
}

function validateKey(value: string): string | null {
  if (!value) return "Key is required";
  if (value.length > MAX_KEY_LENGTH) return "Key is too long";
  if (!VALID_KEY_PATTERN.test(value)) return "Key must match [A-Za-z_][A-Za-z0-9_]*";
  if (RESERVED_KEYS.has(value.toUpperCase())) return `Key '${value}' is reserved`;
  return null;
}

function getUtf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

function createRow(partial?: Partial<SecretRow>): SecretRow {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return {
    id,
    key: "",
    value: "",
    existing: false,
    ...partial,
  };
}

export function SecretsEditor({
  owner,
  name,
  disabled = false,
}: {
  owner?: string;
  name?: string;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const repoReady = Boolean(owner && name);
  const repoLabel = owner && name ? `${owner}/${name}` : "";

  const loadSecrets = useCallback(async () => {
    if (!owner || !name) {
      setRows([]);
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch(`/api/repos/${owner}/${name}/secrets`);
      const data = await response.json();

      if (!response.ok) {
        setError(data?.error || "Failed to load secrets");
        setRows([]);
        return;
      }

      const secrets = Array.isArray(data?.secrets) ? data.secrets : [];
      setRows(
        secrets.map((secret: { key: string }) =>
          createRow({ key: secret.key, value: "", existing: true })
        )
      );
    } catch {
      setError("Failed to load secrets");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [owner, name]);

  useEffect(() => {
    if (!repoReady) {
      setRows([]);
      setError("");
      setSuccess("");
      return;
    }

    let active = true;
    (async () => {
      await loadSecrets();
      if (!active) return;
    })();

    return () => {
      active = false;
    };
  }, [repoReady, loadSecrets]);

  const existingKeySet = useMemo(() => {
    return new Set(rows.filter((row) => row.existing).map((row) => normalizeKey(row.key)));
  }, [rows]);

  const handleAddRow = () => {
    setRows((current) => [...current, createRow()]);
  };

  const handleDeleteRow = async (row: SecretRow) => {
    if (!owner || !name) return;

    if (!row.existing || !row.key) {
      setRows((current) => current.filter((item) => item.id !== row.id));
      return;
    }

    const normalizedKey = normalizeKey(row.key);
    setDeletingKey(normalizedKey);
    setError("");
    setSuccess("");

    try {
      const response = await fetch(`/api/repos/${owner}/${name}/secrets/${normalizedKey}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error || "Failed to delete secret");
        return;
      }
      setSuccess(`Deleted ${normalizedKey}`);
      await loadSecrets();
    } catch {
      setError("Failed to delete secret");
    } finally {
      setDeletingKey(null);
    }
  };

  const handleSave = async () => {
    if (!owner || !name) return;

    setError("");
    setSuccess("");

    const entries = rows
      .filter((row) => row.value.trim().length > 0)
      .map((row) => ({
        key: normalizeKey(row.key),
        value: row.value,
        existing: row.existing,
      }));

    if (entries.length === 0) {
      setSuccess("No changes to save");
      return;
    }

    const uniqueKeys = new Set<string>();
    let totalSize = 0;

    for (const entry of entries) {
      const keyError = validateKey(entry.key);
      if (keyError) {
        setError(keyError);
        return;
      }
      if (uniqueKeys.has(entry.key)) {
        setError(`Duplicate key '${entry.key}'`);
        return;
      }
      uniqueKeys.add(entry.key);

      const valueSize = getUtf8Size(entry.value);
      if (valueSize > MAX_VALUE_SIZE) {
        setError(`Value for '${entry.key}' exceeds ${MAX_VALUE_SIZE} bytes`);
        return;
      }
      totalSize += valueSize;
    }

    if (totalSize > MAX_TOTAL_VALUE_SIZE) {
      setError(`Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`);
      return;
    }

    const netNew = entries.filter((entry) => !existingKeySet.has(entry.key)).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_REPO) {
      setError(`Repository would exceed ${MAX_SECRETS_PER_REPO} secrets limit`);
      return;
    }

    const hasIncompleteNewRow = rows.some(
      (row) => !row.existing && row.key.trim().length > 0 && row.value.trim().length === 0
    );
    if (hasIncompleteNewRow) {
      setError("Enter a value for new secrets or remove the empty row");
      return;
    }

    setSaving(true);

    try {
      const payload: Record<string, string> = {};
      for (const entry of entries) {
        payload[entry.key] = entry.value;
      }

      const response = await fetch(`/api/repos/${owner}/${name}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: payload }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data?.error || "Failed to update secrets");
        return;
      }

      setSuccess("Secrets updated");
      await loadSecrets();
    } catch {
      setError("Failed to update secrets");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 border border-border bg-background p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Secrets</h3>
          <p className="text-xs text-muted-foreground">
            Values are never shown after save. Secrets apply to {repoLabel || "the selected repo"}.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAddRow}
          disabled={!repoReady || disabled}
          className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-foreground hover:border-border transition disabled:opacity-50"
        >
          Add secret
        </button>
      </div>

      {!repoReady && (
        <p className="text-xs text-muted-foreground">Select a repository to manage secrets.</p>
      )}

      {repoReady && (
        <>
          {loading && <p className="text-xs text-muted-foreground">Loading secrets...</p>}

          {!loading && rows.length === 0 && (
            <p className="text-xs text-muted-foreground">No secrets set for this repo.</p>
          )}

          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.id} className="flex flex-col gap-2 border border-border-muted p-2">
                <div className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => {
                      const keyValue = e.target.value;
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, key: keyValue } : item
                        )
                      );
                    }}
                    onBlur={(e) => {
                      const normalized = normalizeKey(e.target.value);
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id ? { ...item, key: normalized } : item
                        )
                      );
                    }}
                    placeholder="KEY_NAME"
                    disabled={disabled || row.existing}
                    className="flex-1 min-w-[160px] bg-input border border-border px-2 py-1 text-xs text-foreground disabled:opacity-60"
                  />
                  <input
                    type="password"
                    value={row.value}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRows((current) =>
                        current.map((item) => (item.id === row.id ? { ...item, value: val } : item))
                      );
                    }}
                    placeholder={row.existing ? "••••••••" : "value"}
                    disabled={disabled}
                    className="flex-1 min-w-[200px] bg-input border border-border px-2 py-1 text-xs text-foreground disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => handleDeleteRow(row)}
                    disabled={disabled || deletingKey === normalizeKey(row.key)}
                    className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-red-500 hover:border-red-300 transition disabled:opacity-50"
                  >
                    {deletingKey === normalizeKey(row.key) ? "Deleting..." : "Delete"}
                  </button>
                </div>
                {row.existing && (
                  <p className="text-[11px] text-muted-foreground">
                    To update, enter a new value and save.
                  </p>
                )}
              </div>
            ))}
          </div>

          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
          {success && <p className="mt-3 text-xs text-green-600">{success}</p>}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={disabled || saving || !repoReady}
              className="text-xs px-3 py-1 border border-border-muted text-foreground hover:border-foreground transition disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save secrets"}
            </button>
            <span className="text-[11px] text-muted-foreground">
              Keys are automatically uppercased.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
