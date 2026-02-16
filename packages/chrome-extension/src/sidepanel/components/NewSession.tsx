import { useState, useEffect } from "react";
import { listRepos, createSession } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ModelSelector, useModelState } from "@/sidepanel/components/ModelSelector";
import type { InstallationRepository } from "@open-inspect/shared";

interface NewSessionProps {
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}

export function NewSession({ onCreated, onCancel }: NewSessionProps) {
  const [repos, setRepos] = useState<InstallationRepository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<InstallationRepository | null>(null);
  const [isLoadingRepos, setIsLoadingRepos] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { model, reasoningEffort, setModel, setReasoningEffort } = useModelState();

  useEffect(() => {
    async function loadRepos() {
      try {
        const data = await listRepos();
        setRepos(data);
        if (data.length > 0) setSelectedRepo(data[0]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load repos");
      } finally {
        setIsLoadingRepos(false);
      }
    }
    loadRepos();
  }, []);

  const handleSubmit = async () => {
    if (!selectedRepo || !prompt.trim()) return;

    setIsCreating(true);
    setError(null);
    try {
      const result = await createSession({
        repoOwner: selectedRepo.owner,
        repoName: selectedRepo.name,
        model,
        reasoningEffort,
        title: prompt.slice(0, 80),
      });
      onCreated(result.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
      setIsCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ash-200">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <ArrowLeftIcon />
        </Button>
        <h2 className="text-sm font-semibold text-ash-900 font-clash">New Session</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* repo selector */}
        <div>
          <label className="block text-xs font-medium text-ash-500 mb-1.5">Repository</label>
          {isLoadingRepos ? (
            <div className="h-10 bg-ash-200 animate-pulse rounded-lg" />
          ) : (
            <select
              value={selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : ""}
              onChange={(e) => {
                const repo = repos.find((r) => `${r.owner}/${r.name}` === e.target.value);
                if (repo) setSelectedRepo(repo);
              }}
              className="w-full px-3 py-2 bg-white border border-ash-300 rounded-lg text-sm text-ash-900 focus:outline-none focus:ring-2 focus:ring-rebolt-500/30 focus:border-rebolt-500"
            >
              {repos.map((repo) => (
                <option key={repo.id} value={`${repo.owner}/${repo.name}`}>
                  {repo.owner}/{repo.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* model selector */}
        <div>
          <label className="block text-xs font-medium text-ash-500 mb-1.5">Model</label>
          <ModelSelector
            model={model}
            reasoningEffort={reasoningEffort}
            onModelChange={setModel}
            onReasoningChange={setReasoningEffort}
          />
        </div>

        {/* prompt input */}
        <div>
          <label className="block text-xs font-medium text-ash-500 mb-1.5">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you want to build or fix..."
            rows={4}
            className="w-full px-3 py-2 bg-white border border-ash-300 rounded-lg text-sm text-ash-900 placeholder:text-ash-400 resize-none focus:outline-none focus:ring-2 focus:ring-rebolt-500/30 focus:border-rebolt-500"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleSubmit();
              }
            }}
          />
        </div>

        {error && (
          <div className="px-3 py-2 bg-lava-100 border border-lava-200 rounded-lg">
            <p className="text-xs text-lava-700">{error}</p>
          </div>
        )}
      </div>

      {/* footer */}
      <div className="px-4 py-3 border-t border-ash-200">
        <Button
          variant="rebolt-primary"
          size="xs"
          onClick={handleSubmit}
          disabled={!selectedRepo || !prompt.trim() || isCreating}
          className="w-full"
        >
          {isCreating ? "Creating..." : "Start Session"}
        </Button>
      </div>
    </div>
  );
}

function ArrowLeftIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
