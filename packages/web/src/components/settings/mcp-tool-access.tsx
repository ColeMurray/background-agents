"use client";

import { useState, type KeyboardEvent } from "react";
import type { McpToolMetadata } from "@open-inspect/shared/types/integrations";
import { discoverMcpTools } from "@/hooks/use-mcp-servers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioCard } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RefreshIcon, SearchIcon, XIcon } from "@/components/ui/icons";

type ToolAccessMode = "all" | "selected";

export interface ToolAccess {
  mode: ToolAccessMode;
  /** Selected tool names; kept but ignored while `mode` is "all". */
  tools: string[];
}

export function toolAccessFromAllowlist(allowlist: string[] | null | undefined): ToolAccess {
  return allowlist == null ? { mode: "all", tools: [] } : { mode: "selected", tools: allowlist };
}

export function toolAccessToAllowlist(access: ToolAccess): string[] | null {
  return access.mode === "all" ? null : [...new Set(access.tools)].sort();
}

type Discovery =
  | { kind: "available"; serverId: string; revision: number }
  | { kind: "unavailable"; reason: string };

/** The outcome of the last Load tools, for the saved connection it used. */
interface LoadedTools {
  connection: string;
  tools?: McpToolMetadata[];
  error?: string;
}

interface McpToolAccessProps {
  value: ToolAccess;
  onChange: (value: ToolAccess) => void;
  radioPrefix: string;
  /** Whether and how this server's tools can be loaded from the server itself. */
  discovery: Discovery;
}

/**
 * Chooses which of a server's tools reach the agent: every tool, or a named
 * subset picked from the tools the server advertises or typed by name.
 */
export function McpToolAccess({ value, onChange, radioPrefix, discovery }: McpToolAccessProps) {
  const [loaded, setLoaded] = useState<LoadedTools | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [manualName, setManualName] = useState("");

  const selected = new Set(value.tools);
  const setTools = (tools: string[]) => onChange({ mode: "selected", tools });

  // Tools loaded through a connection that has since been saved differently, or
  // is being edited, no longer describe the server.
  const connection =
    discovery.kind === "available" ? `${discovery.serverId}@${discovery.revision}` : null;
  const current = loaded?.connection === connection ? loaded : null;
  const catalog = current?.tools ?? null;
  const loadError = current?.error ?? null;

  async function loadTools() {
    if (discovery.kind !== "available" || !connection) return;
    setLoading(true);
    setLoaded((previous) => (previous ? { ...previous, error: undefined } : previous));
    try {
      setLoaded({ connection, tools: await discoverMcpTools(discovery.serverId) });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Failed to load tools";
      setLoaded((previous) => ({
        connection,
        tools: previous?.connection === connection ? previous.tools : undefined,
        error,
      }));
    } finally {
      setLoading(false);
    }
  }

  function addManualName() {
    const name = manualName.trim();
    if (!name) return;
    if (!selected.has(name)) setTools([...value.tools, name]);
    setManualName("");
  }

  function onManualKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      addManualName();
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTools = (catalog ?? []).filter(
    (tool) =>
      !normalizedQuery ||
      tool.name.toLowerCase().includes(normalizedQuery) ||
      tool.description?.toLowerCase().includes(normalizedQuery)
  );
  const catalogNames = new Set((catalog ?? []).map((tool) => tool.name));
  // Selected names the loaded server no longer offers stay visible so they can be removed.
  const missingTools = catalog ? value.tools.filter((tool) => !catalogNames.has(tool)) : [];

  return (
    <div>
      <Label className="mb-1.5">Tools</Label>
      <div className="space-y-2 mb-2">
        <RadioCard
          name={`tool-mode-${radioPrefix}`}
          checked={value.mode === "all"}
          onChange={() => onChange({ mode: "all", tools: value.tools })}
          label="All tools"
          description="Every tool the server offers, including tools it adds later"
        />
        <RadioCard
          name={`tool-mode-${radioPrefix}`}
          checked={value.mode === "selected"}
          onChange={() => onChange({ mode: "selected", tools: value.tools })}
          label="Selected tools only"
          description="The agent can use only the tools you choose"
        />
      </div>

      {value.mode === "selected" && (
        <div className="space-y-2">
          {discovery.kind === "available" && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={loadTools}
                disabled={loading}
              >
                <span className="inline-flex items-center gap-1">
                  <RefreshIcon className="w-3.5 h-3.5" />
                  {loading ? "Loading tools..." : catalog ? "Reload tools" : "Load tools"}
                </span>
              </Button>
              {catalog && (
                <span className="text-xs text-muted-foreground">
                  {value.tools.filter((tool) => catalogNames.has(tool)).length} of {catalog.length}{" "}
                  selected
                </span>
              )}
            </div>
          )}
          {discovery.kind === "unavailable" && (
            <p className="text-xs text-muted-foreground">{discovery.reason}</p>
          )}
          {loadError && (
            <p role="alert" className="text-xs text-destructive">
              {loadError}
            </p>
          )}

          {catalog && (
            <div className="border border-border rounded-sm">
              <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2">
                <SearchIcon className="w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search tools"
                  aria-label="Search tools"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setTools([...new Set([...value.tools, ...visibleTools.map((t) => t.name)])])
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    const hidden = new Set(visibleTools.map((tool) => tool.name));
                    setTools(value.tools.filter((tool) => !hidden.has(tool)));
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {catalog.length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    The server does not offer any tools.
                  </p>
                )}
                {catalog.length > 0 && visibleTools.length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">No matching tools</p>
                )}
                {visibleTools.map((tool) => {
                  const isChecked = selected.has(tool.name);
                  return (
                    <label
                      key={tool.name}
                      className="flex items-start gap-2 px-3 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={isChecked}
                        onCheckedChange={() =>
                          setTools(
                            isChecked
                              ? value.tools.filter((name) => name !== tool.name)
                              : [...value.tools, tool.name]
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block font-mono text-foreground">{tool.name}</span>
                        {tool.description && (
                          <span className="block text-xs text-muted-foreground line-clamp-2">
                            {tool.description}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {(catalog ? missingTools : value.tools).length > 0 && (
            <div>
              {catalog && (
                <p className="text-xs text-muted-foreground mb-1">
                  Selected but not offered by the server:
                </p>
              )}
              <ul className="flex flex-wrap gap-1.5" aria-label="Selected tools">
                {(catalog ? missingTools : value.tools).map((tool) => (
                  <li
                    key={tool}
                    className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground"
                  >
                    {tool}
                    <button
                      type="button"
                      aria-label={`Remove ${tool}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setTools(value.tools.filter((name) => name !== tool))}
                    >
                      <XIcon className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2">
            <Input
              value={manualName}
              onChange={(event) => setManualName(event.target.value)}
              onKeyDown={onManualKeyDown}
              placeholder="Add a tool by name"
              aria-label="Tool name"
            />
            <Button type="button" variant="outline" size="sm" onClick={addManualName}>
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use the tool names the server advertises, such as <code>search_issues</code>.
          </p>

          {value.tools.length === 0 && (
            <p className="text-xs text-warning">
              No tools selected. The agent cannot use any of this server&apos;s tools.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
