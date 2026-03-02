"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import { useRepos, type Repo } from "@/hooks/use-repos";

interface RepoPrimaryAgent {
  id: string;
  description?: string;
}

interface AgentDefault {
  repoOwner: string;
  repoName: string;
  defaultAgent: string | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function AgentsSettings() {
  const { repos, loading: loadingRepos } = useRepos();
  const { data: defaultsData, mutate: mutateDefaults } = useSWR<{ defaults?: AgentDefault[] }>(
    "/api/agent-defaults",
    fetcher
  );
  const defaultsMap = new Map<string, string | null>();
  for (const d of defaultsData?.defaults ?? []) {
    defaultsMap.set(`${d.repoOwner}/${d.repoName}`, d.defaultAgent);
  }

  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const setDefaultForRepo = async (repo: Repo, defaultAgent: string | null) => {
    const key = `${repo.owner}/${repo.name}`;
    setSaving(key);
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/agent-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoOwner: repo.owner,
          repoName: repo.name,
          defaultAgent: defaultAgent || null,
        }),
      });
      if (res.ok) {
        await mutateDefaults();
        setSuccess("Default agent saved.");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save");
      }
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(null);
    }
  };

  if (loadingRepos) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading repositories...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Default agents</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Set a default OpenCode primary agent per repository. Agents are read from{" "}
        <code className="text-xs bg-muted px-1 rounded">.opencode/agents/*.md</code> (Primary agents
        only). If none is selected, the default OpenCode agent is used when starting a session.
      </p>

      {error && (
        <p className="text-sm text-destructive mb-4" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="text-sm text-green-600 dark:text-green-400 mb-4" role="status">
          {success}
        </p>
      )}

      <div className="space-y-6">
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repositories available.</p>
        ) : (
          repos.map((repo) => (
            <RepoAgentRow
              key={`${repo.owner}/${repo.name}`}
              repo={repo}
              currentDefault={defaultsMap.get(`${repo.owner}/${repo.name}`) ?? null}
              onSelect={(agent) => setDefaultForRepo(repo, agent)}
              saving={saving === `${repo.owner}/${repo.name}`}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RepoAgentRow({
  repo,
  currentDefault,
  onSelect,
  saving,
}: {
  repo: Repo;
  currentDefault: string | null;
  onSelect: (agent: string | null) => void;
  saving: boolean;
}) {
  const [agents, setAgents] = useState<RepoPrimaryAgent[] | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true);
    try {
      const res = await fetch(
        `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/agents`
      );
      const data = await res.json();
      setAgents(data.agents ?? []);
    } catch {
      setAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  }, [repo.owner, repo.name]);

  useEffect(() => {
    if (agents !== null) return;
    loadAgents();
  }, [loadAgents, agents]);

  const options: { value: string; label: string }[] = [
    { value: "", label: "OpenCode default" },
    ...(agents ?? []).map((a) => ({
      value: a.id,
      label: a.description ? `${a.id} — ${a.description}` : a.id,
    })),
  ];

  const value = currentDefault ?? "";

  return (
    <div className="border border-border-muted rounded-lg p-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="font-medium text-foreground truncate">{repo.fullName}</p>
          <p className="text-xs text-muted-foreground">Default agent for new sessions</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {loadingAgents ? (
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Loading…
            </span>
          ) : (
            <select
              className="bg-muted border border-border-muted rounded-md px-3 py-1.5 text-sm text-foreground min-w-[180px]"
              value={value}
              onChange={(e) => onSelect(e.target.value || null)}
              disabled={saving}
            >
              {options.map((opt) => (
                <option key={opt.value || "__default__"} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}
