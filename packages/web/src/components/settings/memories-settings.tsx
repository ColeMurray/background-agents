"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import {
  memoryPreferencesSchema,
  memoryViewSchema,
  type MemoryContent,
  type MemoryScope,
  type MemoryStatus,
  type MemoryView,
} from "@open-inspect/shared/types/memories";
import {
  memoryRequest,
  memorySettingsLink,
  memoryScopeQuery,
  useMemory,
  useMemories,
  useMemoryPreferences,
} from "@/hooks/use-memories";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { MemoryEditor } from "./memory-editor";
import { MemoryHistory } from "./memory-history";

const responseSchema = z.object({ memory: memoryViewSchema });
export const PERSONAL_MEMORY_DISCLOSURE =
  "Personal memories included in a session may appear in agent responses and be visible to collaborators.";

/** Persist the account-wide default and disclose the audience of included personal context. */
function PersonalMemoryDefault() {
  const preferences = useMemoryPreferences();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="space-y-2 rounded-sm border border-border p-4">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.data?.includePersonalMemories ?? false}
          disabled={!preferences.data || saving}
          onChange={async (event) => {
            setSaving(true);
            setError("");
            try {
              const data = await memoryRequest("/api/memory-preferences", memoryPreferencesSchema, {
                method: "PUT",
                body: JSON.stringify({ includePersonalMemories: event.target.checked }),
              });
              await preferences.mutate(data, false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Save failed");
            } finally {
              setSaving(false);
            }
          }}
        />
        Include my personal memories in new sessions by default
      </label>
      <p className="text-xs text-muted-foreground">
        Applies across web and integration-created sessions. You can override it when starting a web
        session. Existing sessions keep their original selection.
      </p>
      <p className="text-xs text-muted-foreground">{PERSONAL_MEMORY_DISCLOSURE}</p>
      {(error || preferences.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || "Could not load memory preferences."}
        </p>
      )}
    </div>
  );
}

/** Manage a paginated scope using server capabilities and revision-fenced mutations. */
function MemoryCollection({ scope }: { scope: MemoryScope }) {
  const params = useSearchParams();
  const focused = useMemory(params.get("memoryId"));
  const [selectedStatus, setStatus] = useState<MemoryStatus | null>(null);
  const status = selectedStatus ?? focused.data?.memory.status ?? "active";
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error, mutate } = useMemories(scope, status, offset);
  // Deep links remain visible even when their record is outside the current page.
  const focusedRecord = focused.data?.memory;
  const pageRecords = data?.memories ?? [];
  const records =
    focusedRecord &&
    focusedRecord.status === status &&
    memoryScopeQuery(focusedRecord.scope).toString() === memoryScopeQuery(scope).toString() &&
    !pageRecords.some((record) => record.id === focusedRecord.id)
      ? [focusedRecord, ...pageRecords]
      : pageRecords;
  const [editor, setEditor] = useState<{ record?: MemoryView; supersedes?: string } | null>(null);
  const [history, setHistory] = useState<string | null>(params.get("memoryId"));
  const [archive, setArchive] = useState<MemoryView | null>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Serialize lifecycle actions and refresh both the collection and any deep-linked record. */
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError("");
    try {
      await action();
      await Promise.all([mutate(), focused.mutate()]);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Memory action failed");
    } finally {
      setBusy(false);
    }
  }
  /** Send editable content only, carrying the reviewed revision when editing an existing record. */
  async function save(content: MemoryContent, record?: MemoryView, supersedes?: string) {
    await memoryRequest(
      record ? `/api/memories/${encodeURIComponent(record.id)}` : "/api/memories",
      responseSchema,
      {
        method: record ? "PATCH" : "POST",
        body: JSON.stringify(
          record
            ? { ...content, expectedRevisionId: record.currentRevisionId }
            : { ...content, scope, ...(supersedes ? { supersedesMemoryId: supersedes } : {}) }
        ),
      }
    );
    setEditor(null);
    await Promise.all([mutate(), focused.mutate()]);
  }
  /** Apply a lifecycle decision to the exact revision currently displayed. */
  async function action(
    record: MemoryView,
    name: "archive" | "restore" | "approve" | "reject",
    reason?: string
  ) {
    await memoryRequest(`/api/memories/${encodeURIComponent(record.id)}/${name}`, responseSchema, {
      method: "POST",
      body: JSON.stringify({
        expectedRevisionId: record.currentRevisionId,
        ...(reason ? { reason } : {}),
      }),
    });
    setArchive(null);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Memory status">
          {(["active", "proposed", "archived"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              role="tab"
              aria-selected={status === value}
              variant={status === value ? "primary" : "outline"}
              size="sm"
              onClick={() => {
                setStatus(value);
                setOffset(0);
                setEditor(null);
              }}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </div>
        {data?.canCreate && (
          <Button type="button" size="sm" onClick={() => setEditor({})}>
            New memory
          </Button>
        )}
      </div>
      <nav className="flex gap-2" aria-label="Memory pages">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={offset === 0 || isLoading}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous page
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={data?.nextOffset == null || isLoading}
          onClick={() => {
            if (data?.nextOffset != null) setOffset(data.nextOffset);
          }}
        >
          Next page
        </Button>
      </nav>
      {editor && (
        <MemoryEditor
          key={editor.record?.currentRevisionId ?? editor.supersedes ?? "new"}
          record={editor.record}
          onSave={(content) => save(content, editor.record, editor.supersedes)}
          onCancel={() => setEditor(null)}
        />
      )}
      {(error || actionError) && (
        <p role="alert" className="text-sm text-destructive">
          {actionError || "Unable to load memories."}
        </p>
      )}
      {isLoading && <p className="text-sm text-muted-foreground">Loading memories…</p>}
      {!isLoading && records.length === 0 && !!data && (
        <p className="text-sm text-muted-foreground">No {status} memories for this scope.</p>
      )}
      {records.map((record) => (
        <article
          key={record.id}
          id={record.id}
          className="space-y-3 rounded-sm border border-border p-4"
        >
          <div>
            <h3 className="font-medium">{record.title}</h3>
            <p className="text-xs text-muted-foreground">
              {record.memoryType === "directive"
                ? "Directive · included in full"
                : "Fact · read when relevant"}{" "}
              · Revision {record.revisionNumber} ·{" "}
              {record.authorKind === "agent" && record.authorSessionId ? (
                <a
                  className="underline"
                  href={`/session/${encodeURIComponent(record.authorSessionId)}`}
                >
                  Agent session
                </a>
              ) : (
                "User-authored"
              )}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{record.description}</p>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">
            {record.content}
          </pre>
          {record.archiveReason && (
            <p className="text-xs text-muted-foreground">Archive reason: {record.archiveReason}</p>
          )}
          {record.supersedesMemoryId && (
            <p className="text-xs text-muted-foreground">
              Replaces{" "}
              <a
                className="underline"
                href={memorySettingsLink(record.scope, record.supersedesMemoryId)}
              >
                {record.supersedesMemoryId}
              </a>
              {record.status === "proposed" ? " after approval" : ""}
            </p>
          )}
          {record.replacementMemoryIds?.map((id) => (
            <p key={id} className="text-xs text-muted-foreground">
              Replacement:{" "}
              <a className="underline" href={memorySettingsLink(record.scope, id)}>
                {id}
              </a>
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            {record.capabilities.canEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setEditor({ record })}
              >
                Edit
              </Button>
            )}
            {record.capabilities.canEdit && record.status === "active" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setEditor({ supersedes: record.id })}
              >
                Replace
              </Button>
            )}
            {record.capabilities.canApprove && (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void perform(() => action(record, "approve"))}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void perform(() => action(record, "reject"))}
                >
                  Reject
                </Button>
              </>
            )}
            {record.capabilities.canArchive &&
              (record.status === "archived" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void perform(() => action(record, "restore"))}
                >
                  Restore
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setArchive(record);
                    setReason("");
                  }}
                >
                  Archive
                </Button>
              ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setHistory(history === record.id ? null : record.id)}
            >
              Revision history
            </Button>
          </div>
          {archive?.id === record.id && (
            <div className="space-y-2">
              <label className="text-sm">
                Archive reason (optional)
                <Input
                  value={reason}
                  maxLength={1000}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                New sessions will omit this memory. Text already included in a running session
                cannot be removed.
              </p>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void perform(() => action(record, "archive", reason))}
              >
                Confirm archive
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setArchive(null)}>
                Cancel
              </Button>
            </div>
          )}
          {history === record.id && (
            <MemoryHistory
              key={record.currentRevisionId}
              record={record}
              onRestore={(content) => perform(() => save(content, record))}
            />
          )}
        </article>
      ))}
    </div>
  );
}

/** Combine owner-only memory management with the future-session inclusion default. */
export function MemoriesSettings() {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Memories</h2>
        <p className="text-sm text-muted-foreground">
          Personal directives are your custom instructions. Facts preserve useful knowledge across
          sessions.
        </p>
      </div>
      <PersonalMemoryDefault />
      <MemoryCollection scope={{ type: "personal" }} />
    </section>
  );
}

/** Select an accessible repository/environment; management capabilities come from the API. */
export function SharedMemoriesSettings() {
  const params = useSearchParams();
  const { repos, loading: reposLoading, error: reposError } = useRepos();
  const {
    environments,
    loading: environmentsLoading,
    error: environmentsError,
  } = useEnvironments();
  const [selection, setSelection] = useState<string | null>(null);
  const initialRepo = repos.find(
    (repo) => repo.owner === params.get("repoOwner") && repo.name === params.get("repoName")
  );
  const selected =
    selection ??
    (params.get("environmentId")
      ? `env:${params.get("environmentId")}`
      : initialRepo
        ? `repo:${initialRepo.id}`
        : "");
  const repo = repos.find((repo) => `repo:${repo.id}` === selected);
  const environment = environments.find((environment) => `env:${environment.id}` === selected);
  const scope: MemoryScope | null = repo
    ? { type: "repository", repoOwner: repo.owner, repoName: repo.name }
    : environment
      ? { type: "environment", environmentId: environment.id }
      : null;
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Shared memories</h2>
        <p className="text-sm text-muted-foreground">
          Curate repository and environment knowledge. Agent proposals require approval before other
          sessions load them.
        </p>
      </div>
      <Select value={selected} onValueChange={setSelection}>
        <SelectTrigger aria-label="Memory scope">
          <SelectValue placeholder="Choose a repository or environment" />
        </SelectTrigger>
        <SelectContent>
          {repos.map((repo) => (
            <SelectItem key={`repo:${repo.id}`} value={`repo:${repo.id}`}>
              {repo.fullName}
            </SelectItem>
          ))}
          {environments.map((environment) => (
            <SelectItem key={`env:${environment.id}`} value={`env:${environment.id}`}>
              Environment: {environment.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(reposLoading || environmentsLoading) && <p className="text-sm">Loading scopes…</p>}
      {(reposError || environmentsError) && (
        <p role="alert">Some memory scopes could not be loaded.</p>
      )}
      {scope ? (
        <MemoryCollection key={selected} scope={scope} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a scope to view its memories.</p>
      )}
    </section>
  );
}
