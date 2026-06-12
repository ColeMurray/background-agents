"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { useRepos } from "@/hooks/use-repos";

const GLOBAL_SCOPE = "__global__";
const MAX_VALUE_SIZE = 16384;
const MAX_TOTAL_VALUE_SIZE = 65536;

const MODEL_API_KEYS = [
  {
    key: "ANTHROPIC_API_KEY",
    provider: "Anthropic",
    description: "Claude models in Anthropic provider sessions",
    placeholder: "sk-ant-...",
  },
  {
    key: "OPENAI_API_KEY",
    provider: "OpenAI",
    description: "GPT and Codex models in OpenAI provider sessions",
    placeholder: "sk-...",
  },
  {
    key: "OPENCODE_API_KEY",
    provider: "OpenCode Zen",
    description: "Zen-routed OpenCode models",
    placeholder: "opencode_...",
  },
] as const;

type ModelApiKeyName = (typeof MODEL_API_KEYS)[number]["key"];

type SecretMeta = {
  key: string;
  createdAt?: number;
  updatedAt?: number;
};

interface SecretsResponse {
  secrets: SecretMeta[];
  globalSecrets?: SecretMeta[];
}

function createEmptyValues(): Record<ModelApiKeyName, string> {
  return MODEL_API_KEYS.reduce(
    (acc, item) => {
      acc[item.key] = "";
      return acc;
    },
    {} as Record<ModelApiKeyName, string>
  );
}

function getUtf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function ModelApiKeysSettings() {
  const { repos, loading: loadingRepos } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState(GLOBAL_SCOPE);
  const [values, setValues] = useState<Record<ModelApiKeyName, string>>(createEmptyValues);
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<ModelApiKeyName | null>(null);
  const [error, setError] = useState("");

  const selectedRepoObj = repos.find((repo) => repo.fullName === selectedRepo);
  const isGlobal = selectedRepo === GLOBAL_SCOPE;
  const ready = isGlobal || Boolean(selectedRepoObj);
  const apiBase = isGlobal
    ? "/api/secrets"
    : selectedRepoObj
      ? `/api/repos/${selectedRepoObj.owner}/${selectedRepoObj.name}/secrets`
      : null;

  const {
    data,
    isLoading,
    error: fetchError,
  } = useSWR<SecretsResponse>(ready && apiBase ? apiBase : null);

  useEffect(() => {
    setValues(createEmptyValues());
    setError("");
  }, [apiBase]);

  const directKeys = useMemo(
    () => new Set((data?.secrets ?? []).map((secret) => secret.key.toUpperCase())),
    [data?.secrets]
  );
  const inheritedKeys = useMemo(
    () => new Set((data?.globalSecrets ?? []).map((secret) => secret.key.toUpperCase())),
    [data?.globalSecrets]
  );

  const changedKeys = MODEL_API_KEYS.filter((item) => values[item.key].trim().length > 0);
  const hasChanges = changedKeys.length > 0;

  const selectedRepoLabel = isGlobal
    ? "All Repositories (Global)"
    : selectedRepoObj
      ? selectedRepoObj.fullName
      : loadingRepos
        ? "Loading..."
        : "Select a repository";

  async function handleSave() {
    if (!apiBase || changedKeys.length === 0) return;

    setError("");

    let totalSize = 0;
    for (const item of changedKeys) {
      const value = values[item.key].trim();
      const valueSize = getUtf8Size(value);
      if (valueSize > MAX_VALUE_SIZE) {
        setError(`${item.key} exceeds ${MAX_VALUE_SIZE} bytes`);
        return;
      }
      totalSize += valueSize;
    }

    if (totalSize > MAX_TOTAL_VALUE_SIZE) {
      setError(`Model API key values exceed ${MAX_TOTAL_VALUE_SIZE} bytes total`);
      return;
    }

    setSaving(true);
    try {
      const payload: Partial<Record<ModelApiKeyName, string>> = {};
      for (const item of changedKeys) {
        payload[item.key] = values[item.key].trim();
      }

      const response = await fetch(apiBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: payload }),
      });
      const body = await readJson(response);

      if (!response.ok) {
        toast.error(String(body.error || "Failed to save model API keys"));
        return;
      }

      setValues(createEmptyValues());
      mutate(apiBase);
      toast.success("Model API keys saved");
    } catch {
      toast.error("Failed to save model API keys");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(key: ModelApiKeyName) {
    if (!apiBase) return;

    setDeletingKey(key);
    try {
      const response = await fetch(`${apiBase}/${key}`, { method: "DELETE" });
      const body = await readJson(response);

      if (!response.ok) {
        toast.error(String(body.error || `Failed to remove ${key}`));
        return;
      }

      setValues((current) => ({ ...current, [key]: "" }));
      mutate(apiBase);
      toast.success(`${key} removed`);
    } catch {
      toast.error(`Failed to remove ${key}`);
    } finally {
      setDeletingKey(null);
    }
  }

  return (
    <section className="mt-10 border-t border-border-muted pt-8" aria-labelledby="model-api-keys">
      <h2 id="model-api-keys" className="text-xl font-semibold text-foreground mb-1">
        Model API Keys
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        Store provider credentials as encrypted secrets for model execution. Repository keys
        override global keys.
      </p>

      <div className="mb-6">
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={setSelectedRepo}
          items={repos.map((repo) => ({
            value: repo.fullName,
            label: repo.name,
            description: `${repo.owner}${repo.private ? " \u2022 private" : ""}`,
          }))}
          searchable
          searchPlaceholder="Search repositories..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            (option.description?.toLowerCase().includes(query) ?? false) ||
            String(option.value).toLowerCase().includes(query)
          }
          direction="down"
          dropdownWidth="w-full max-w-sm"
          maxDisplayed={100}
          disabled={loadingRepos}
          triggerClassName="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
          prependContent={({ select }) => (
            <>
              <button
                type="button"
                onClick={() => select(GLOBAL_SCOPE)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                  isGlobal ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                <div className="flex flex-col items-start text-left">
                  <span className="font-medium">All Repositories (Global)</span>
                  <span className="text-xs text-secondary-foreground">
                    Shared across all repositories
                  </span>
                </div>
                {isGlobal && <CheckIcon className="w-4 h-4 text-accent" />}
              </button>
              {repos.length > 0 && <div className="border-t border-border my-1" />}
            </>
          )}
        >
          <span className="truncate">{selectedRepoLabel}</span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </Combobox>
      </div>

      {!ready && (
        <p className="text-sm text-muted-foreground">Select a repository to manage model keys.</p>
      )}

      {ready && (
        <>
          {isLoading && <p className="text-sm text-muted-foreground">Loading model keys...</p>}
          {fetchError && <p className="text-sm text-destructive">Failed to load model keys.</p>}

          {!isLoading && !fetchError && (
            <div className="space-y-3">
              {MODEL_API_KEYS.map((item) => {
                const hasDirectKey = directKeys.has(item.key);
                const hasInheritedKey = !isGlobal && inheritedKeys.has(item.key);
                const status = hasDirectKey ? "Set" : hasInheritedKey ? "Inherited" : "Not set";

                return (
                  <div key={item.key} className="border border-border bg-background px-4 py-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <div className="min-w-0 sm:w-56">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-medium text-foreground">{item.provider}</h3>
                          <span className="rounded-sm border border-border-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                        <p className="mt-1 font-mono text-xs text-secondary-foreground">
                          {item.key}
                        </p>
                      </div>

                      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
                        <Input
                          type="password"
                          value={values[item.key]}
                          aria-label={`${item.provider} API key`}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [item.key]: event.target.value,
                            }))
                          }
                          placeholder={
                            hasDirectKey
                              ? "Enter a new value to update"
                              : hasInheritedKey
                                ? "Enter a repo override"
                                : item.placeholder
                          }
                          className="min-w-0 flex-1"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          aria-label={`Remove ${item.key}`}
                          onClick={() => handleDelete(item.key)}
                          disabled={saving || !hasDirectKey || deletingKey === item.key}
                        >
                          {deletingKey === item.key ? "Removing..." : "Remove"}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={!hasChanges || saving || isLoading || Boolean(fetchError)}
            >
              {saving ? "Saving..." : "Save API Keys"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Saved values are never displayed again. Leave a field empty to keep its current value.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
