"use client";

import { useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { useRepos } from "@/hooks/use-repos";
import { Combobox } from "@/components/ui/combobox";
import { ChevronDownIcon } from "@/components/ui/icons";
import type {
  RepoContextDocument,
  ContextSearchResult,
  ContextDocumentSourceType,
} from "@open-inspect/shared";

interface ContextDocumentsResponse {
  documents: RepoContextDocument[];
}

const SOURCE_TYPES: ContextDocumentSourceType[] = [
  "meeting",
  "slack",
  "linear",
  "note",
  "upload",
  "other",
];

function getDocumentIndexError(document: RepoContextDocument): string | null {
  const indexing = document.metadata?.indexing;
  if (!indexing || typeof indexing !== "object") return null;
  const error = (indexing as { error?: unknown }).error;
  return typeof error === "string" && error.trim().length > 0 ? error : null;
}

export function ContextDocumentsSettings() {
  const { repos, loading: loadingRepos } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState("");
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState<ContextDocumentSourceType>("note");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ContextSearchResult[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const selectedRepoObj = useMemo(
    () => repos.find((repo) => repo.fullName === selectedRepo),
    [repos, selectedRepo]
  );
  const ready = Boolean(selectedRepoObj?.owner && selectedRepoObj.name);
  const apiBase =
    selectedRepoObj?.owner && selectedRepoObj.name
      ? `/api/repos/${selectedRepoObj.owner}/${selectedRepoObj.name}/context/documents`
      : null;
  const { data, isLoading } = useSWR<ContextDocumentsResponse>(apiBase);
  const documents = data?.documents || [];

  async function handleSaveDocument() {
    if (!ready || !apiBase) return;
    if (!title.trim() || !content.trim()) {
      setError("Title and content are required");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(apiBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: {
            title: title.trim(),
            sourceType,
            content,
            tags: tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
            createdBy: "web-user",
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error || "Failed to save context document");
        return;
      }
      setTitle("");
      setTags("");
      setContent("");
      setSuccess("Context document saved");
      mutate(apiBase);
    } catch {
      setError("Failed to save context document");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDocument(documentId: string) {
    if (!ready || !apiBase) return;
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`${apiBase}/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error || "Failed to delete context document");
        return;
      }
      setSuccess("Document deleted");
      mutate(apiBase);
    } catch {
      setError("Failed to delete context document");
    }
  }

  async function handleSearch() {
    if (!ready || !selectedRepoObj || !searchQuery.trim()) return;
    setSearching(true);
    setError("");
    try {
      const response = await fetch(
        `/api/repos/${selectedRepoObj.owner}/${selectedRepoObj.name}/context/search_context`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: searchQuery, maxResults: 6 }),
        }
      );
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error || "Failed to search context");
        setSearchResults([]);
        return;
      }
      setSearchResults(payload.results || []);
    } catch {
      setError("Failed to search context");
    } finally {
      setSearching(false);
    }
  }

  async function handleReindexDocument(documentId: string) {
    if (!ready || !apiBase || !selectedRepoObj) return;
    setError("");
    setSuccess("");
    try {
      const response = await fetch(
        `/api/repos/${selectedRepoObj.owner}/${selectedRepoObj.name}/context/documents/${encodeURIComponent(documentId)}/reindex`,
        { method: "POST" }
      );
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error || "Failed to queue reindex");
        return;
      }
      setSuccess("Reindex queued");
      mutate(apiBase);
    } catch {
      setError("Failed to queue reindex");
    }
  }

  return (
    <div className="mt-8 border border-border bg-background p-4">
      <h3 className="text-base font-semibold text-foreground">Context Documents</h3>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Upload and manage business context used for retrieval-augmented prompts.
      </p>

      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={setSelectedRepo}
          items={repos.map((repo) => ({
            value: repo.fullName,
            label: repo.name,
            description: `${repo.owner}${repo.private ? " • private" : ""}`,
          }))}
          searchable
          searchPlaceholder="Search repositories..."
          direction="down"
          dropdownWidth="w-full max-w-sm"
          disabled={loadingRepos}
          triggerClassName="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <span className="truncate">
            {selectedRepoObj?.fullName || (loadingRepos ? "Loading..." : "Select a repository")}
          </span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </Combobox>
      </div>

      {!ready && (
        <p className="text-xs text-muted-foreground">
          Choose a repository to manage context documents.
        </p>
      )}

      {ready && (
        <>
          <div className="space-y-2 mb-4">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
              className="w-full bg-input border border-border px-3 py-2 text-sm text-foreground"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as ContextDocumentSourceType)}
                className="bg-input border border-border px-3 py-2 text-sm text-foreground"
              >
                {SOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Tags (comma separated)"
                className="bg-input border border-border px-3 py-2 text-sm text-foreground"
              />
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste meeting notes, Slack digest, Linear summary..."
              rows={6}
              className="w-full bg-input border border-border px-3 py-2 text-sm text-foreground resize-y"
            />
            <button
              type="button"
              onClick={handleSaveDocument}
              disabled={saving}
              className="text-xs px-3 py-1.5 border border-border-muted text-foreground hover:border-foreground transition disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save document"}
            </button>
          </div>

          <div className="space-y-2 mb-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search indexed context..."
                className="flex-1 bg-input border border-border px-3 py-2 text-sm text-foreground"
              />
              <button
                type="button"
                onClick={handleSearch}
                disabled={searching || !searchQuery.trim()}
                className="text-xs px-3 py-2 border border-border-muted text-foreground hover:border-foreground transition disabled:opacity-50"
              >
                {searching ? "Searching..." : "Search"}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="border border-border-muted p-2 space-y-2">
                {searchResults.map((result) => (
                  <div key={result.id} className="text-xs">
                    <div className="text-foreground font-medium">
                      {result.title} ({Math.round(result.score * 100)}%)
                    </div>
                    <p className="text-muted-foreground">
                      {result.citations[0]?.excerpt || "No excerpt"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="text-sm font-medium text-foreground mb-2">Saved documents</h4>
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Loading documents...</p>
            ) : documents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No context documents saved yet.</p>
            ) : (
              <div className="space-y-2">
                {documents.map((document) => (
                  <div key={document.id} className="border border-border-muted p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm text-foreground font-medium">{document.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {document.sourceType} · {document.ingestStatus}
                        </p>
                        {document.ingestStatus === "failed" && (
                          <p className="text-[11px] text-destructive mt-1">
                            {getDocumentIndexError(document) || "Indexing failed"}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleReindexDocument(document.id)}
                          className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-foreground hover:border-foreground/30 transition"
                        >
                          Reindex
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteDocument(document.id)}
                          className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-destructive hover:border-destructive/40 transition"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      {success && <p className="mt-3 text-xs text-success">{success}</p>}
    </div>
  );
}
