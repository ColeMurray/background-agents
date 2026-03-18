"use client";

import { useState, useEffect } from "react";
import type { McpServerConfig } from "@open-inspect/shared";
import {
  useMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
} from "@/hooks/use-mcp-servers";
import { useRepos } from "@/hooks/use-repos";
import { PlusIcon, TerminalIcon, GlobeIcon, ErrorIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";

type ScopeMode = "global" | "selected";

type FormState = {
  name: string;
  type: "stdio" | "remote";
  command: string;
  url: string;
  env: string;
  repoScopes: string[];
  scopeMode: ScopeMode;
  enabled: boolean;
};

const emptyForm: FormState = {
  name: "",
  type: "remote",
  command: "",
  url: "",
  env: "",
  repoScopes: [],
  scopeMode: "global",
  enabled: true,
};

function configToForm(config: McpServerConfig): FormState {
  return {
    name: config.name,
    type: config.type,
    command:
      config.command
        ?.map((t) =>
          // Quote any token containing whitespace or shell-special chars so the
          // display string round-trips correctly through parseCommand().
          // The command array is always the canonical source of truth.
          /[\s$`#!&|;<>(){}\\"]/.test(t) ? `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : t
        )
        .join(" ") ?? "",
    url: config.url ?? "",
    // For remote servers, the relevant key/value pairs are HTTP headers (McpServerConfig.headers).
    // For stdio servers, they are process environment variables (McpServerConfig.env).
    env: (() => {
      const pairs = config.type === "remote" ? config.headers : config.env;
      return pairs && Object.keys(pairs).length > 0
        ? Object.entries(pairs)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
        : "";
    })(),
    repoScopes: config.repoScopes ?? [],
    scopeMode: config.repoScopes?.length ? "selected" : "global",
    enabled: config.enabled,
  };
}

function parseEnv(envStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of envStr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      result[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  return result;
}

/** Minimal shell-quote aware parser: respects "..." and '...' grouping. */
function parseCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

interface McpServerFormProps {
  form: FormState;
  setForm: (form: FormState) => void;
  repos: { fullName: string; private?: boolean }[];
  loadingRepos: boolean;
  radioPrefix: string;
}

function McpServerForm({ form, setForm, repos, loadingRepos, radioPrefix }: McpServerFormProps) {
  return (
    <>
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Name</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. playwright, context7"
          className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Type</label>
        <div className="flex gap-2">
          <button
            onClick={() => setForm({ ...form, type: "remote" })}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
              form.type === "remote"
                ? "border-foreground/30 text-foreground bg-muted"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <GlobeIcon className="w-3.5 h-3.5" />
            Remote
          </button>
          <button
            onClick={() => setForm({ ...form, type: "stdio" })}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
              form.type === "stdio"
                ? "border-foreground/30 text-foreground bg-muted"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            Stdio
          </button>
        </div>
      </div>

      {form.type === "remote" ? (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">URL</label>
          <input
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://mcp.example.com/sse"
            className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30"
          />
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Command</label>
          <input
            type="text"
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            placeholder="npx -y @playwright/mcp"
            className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Space-separated command and arguments. Use quotes for arguments with spaces.
          </p>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          {form.type === "remote" ? "HTTP Headers" : "Environment Variables"}{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <textarea
          value={form.env}
          onChange={(e) => setForm({ ...form, env: e.target.value })}
          placeholder={
            form.type === "remote"
              ? "Authorization=Bearer <token>\nX-Custom-Header=value"
              : "KEY=value\nANOTHER_KEY=value"
          }
          rows={3}
          className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30 font-mono"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-2">Availability</label>
        <div className="space-y-2 mb-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name={`scope-mode-${radioPrefix}`}
              checked={form.scopeMode === "global"}
              onChange={() => setForm({ ...form, scopeMode: "global", repoScopes: [] })}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm text-foreground">All repositories</span>
              <p className="text-xs text-muted-foreground">Available in every agent session</p>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name={`scope-mode-${radioPrefix}`}
              checked={form.scopeMode === "selected"}
              onChange={() => setForm({ ...form, scopeMode: "selected" })}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm text-foreground">Selected repositories only</span>
              <p className="text-xs text-muted-foreground">
                Only available in sessions for chosen repos
              </p>
            </div>
          </label>
        </div>

        {form.scopeMode === "selected" && (
          <>
            {loadingRepos ? (
              <p className="text-sm text-muted-foreground px-3 py-2">Loading repositories...</p>
            ) : repos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-3 py-2 border border-border rounded-sm">
                No repositories available. Connect a GitHub integration first.
              </p>
            ) : (
              <div className="border border-border max-h-40 overflow-y-auto rounded-sm">
                {repos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = form.repoScopes.includes(fullName);
                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          const next = isChecked
                            ? form.repoScopes.filter((r) => r !== fullName)
                            : [...form.repoScopes, fullName];
                          setForm({ ...form, repoScopes: next });
                        }}
                        className="rounded border-border"
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                      {repo.private && (
                        <span className="text-xs text-muted-foreground">private</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            {form.repoScopes.length === 0 && repos.length > 0 && (
              <p className="text-xs text-amber-500 mt-1">
                Select a repository or switch to &quot;All repositories&quot;.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`mcp-enabled-${radioPrefix}`}
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          className="rounded border-border"
        />
        <label htmlFor={`mcp-enabled-${radioPrefix}`} className="text-sm text-foreground">
          Enabled
        </label>
      </div>
    </>
  );
}

export function McpServersSettings() {
  const { servers, loading, mutate } = useMcpServers();
  const { repos, loading: loadingRepos } = useRepos();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Sync SWR background refreshes into the open edit form
  useEffect(() => {
    if (editing && editing !== "new") {
      const current = servers.find((s) => s.id === editing);
      if (current) setForm(configToForm(current));
    }
    // setForm is stable (useState setter), configToForm is a module-level pure fn
  }, [servers, editing]);

  function startNew() {
    setExpanded(null);
    setForm(emptyForm);
    setEditing("new");
    setError(null);
  }

  function startEdit(server: McpServerConfig) {
    if (expanded === server.id) {
      setExpanded(null);
      setEditing(null);
    } else {
      setForm(configToForm(server));
      setEditing(server.id);
      setExpanded(server.id);
    }
    setError(null);
  }

  function cancel() {
    setEditing(null);
    setExpanded(null);
    setError(null);
  }

  async function save() {
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (form.type === "remote" && !form.url.trim()) {
      setError("URL is required for remote servers");
      return;
    }
    if (form.type === "stdio" && !form.command.trim()) {
      setError("Command is required for stdio servers");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload: Partial<McpServerConfig> = {
        name: form.name.trim(),
        type: form.type,
        enabled: form.enabled,
        repoScopes:
          form.scopeMode === "selected" && form.repoScopes.length > 0 ? form.repoScopes : null,
      };

      if (form.type === "remote") {
        payload.url = form.url.trim();
        // Remote servers use HTTP headers for auth (e.g. Authorization: Bearer <token>)
        payload.headers = parseEnv(form.env);
      } else {
        payload.command = parseCommand(form.command);
        payload.env = parseEnv(form.env);
      }

      if (editing === "new") {
        await createMcpServer(payload as Omit<McpServerConfig, "id">);
      } else if (editing) {
        await updateMcpServer(editing, payload);
      }

      setEditing(null);
      mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this MCP server? This cannot be undone.")) return;
    try {
      await deleteMcpServer(id);
      mutate();
      if (editing === id) setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleToggle(server: McpServerConfig) {
    try {
      await updateMcpServer(server.id, { enabled: !server.enabled });
      mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold text-foreground">MCP Servers</h2>
        <Button onClick={startNew} variant="outline" size="sm">
          <span className="inline-flex items-center gap-1">
            <PlusIcon className="w-3.5 h-3.5" />
            Add Server
          </span>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Configure Model Context Protocol servers that are available to agent sessions.
      </p>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400 mb-4 px-3 py-2 bg-red-400/10 rounded">
          <ErrorIcon className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* New server form */}
      {editing === "new" && (
        <div className="border border-border rounded-md p-4 mb-6 space-y-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-foreground">New MCP Server</h3>
            <button
              onClick={cancel}
              className="p-1 text-muted-foreground hover:text-foreground transition"
              aria-label="Close"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <McpServerForm
            form={form}
            setForm={setForm}
            repos={repos}
            loadingRepos={loadingRepos}
            radioPrefix="new"
          />
          <div className="flex gap-2 pt-2">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving..." : "Add Server"}
            </Button>
            <Button onClick={cancel} variant="outline" size="sm">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : servers.length === 0 && editing !== "new" ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          No MCP servers configured. Add one to extend agent capabilities.
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const isExpanded = expanded === server.id;
            return (
              <div
                key={server.id}
                className={`border rounded-md transition ${
                  server.enabled
                    ? "border-border bg-card"
                    : "border-border/50 bg-card/50 opacity-60"
                }`}
              >
                {/* Header row */}
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer"
                  onClick={() => startEdit(server)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <svg
                      className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    {server.type === "remote" ? (
                      <GlobeIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <TerminalIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {server.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {server.type === "remote" ? server.url : server.command?.join(" ")}
                        {server.repoScopes?.length ? (
                          <span className="ml-2 text-accent">
                            •{" "}
                            {server.repoScopes.length === 1
                              ? server.repoScopes[0]
                              : `${server.repoScopes.length} repos`}
                          </span>
                        ) : (
                          <span className="ml-2 text-muted-foreground/60">• global</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex items-center gap-1 flex-shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => handleToggle(server)}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition"
                    >
                      {server.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => handleDelete(server.id)}
                      className="px-2 py-1 text-xs text-red-400 hover:text-red-300 transition"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Expanded edit form */}
                {isExpanded && editing === server.id && (
                  <div className="px-4 pb-4 pt-3 border-t border-border space-y-4">
                    <McpServerForm
                      form={form}
                      setForm={setForm}
                      repos={repos}
                      loadingRepos={loadingRepos}
                      radioPrefix={server.id}
                    />
                    <div className="flex gap-2 pt-2">
                      <Button onClick={save} disabled={saving} size="sm">
                        {saving ? "Saving..." : "Save Changes"}
                      </Button>
                      <Button onClick={cancel} variant="outline" size="sm">
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
