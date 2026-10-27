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
  return access.mode === "all" ? null : access.tools;
}

/** Whether and how a server's tools can be loaded from the server itself. */
export type McpToolDiscovery =
  | { kind: "available"; serverId: string; revision: number }
  | { kind: "unavailable"; reason: string };

interface McpToolAccessProps {
  value: ToolAccess;
  onChange: (value: ToolAccess) => void;
  radioPrefix: string;
  discovery: McpToolDiscovery;
}

/**
 * Chooses which of a server's tools reach the agent: every tool, or a named
 * subset picked from the tools the server advertises or typed by name.
 */
export function McpToolAccess({ value, onChange, radioPrefix, discovery }: McpToolAccessProps) {
  const setTools = (tools: string[]) => onChange({ mode: "selected", tools });
  const removeTool = (name: string) => setTools(value.tools.filter((tool) => tool !== name));

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
          <p className="text-xs text-muted-foreground">
            This limits which tools agents are offered. Claude Agent still lists the other tools but
            refuses to run them, and the server&apos;s saved headers and environment still reach the
            sandbox.
          </p>
          {discovery.kind === "available" ? (
            // Keyed by the saved server revision, so tools loaded before a later save
            // (which may have changed the connection) are discarded.
            <McpToolCatalog
              key={`${discovery.serverId}@${discovery.revision}`}
              serverId={discovery.serverId}
              tools={value.tools}
              onChange={setTools}
            />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{discovery.reason}</p>
              <SelectedTools names={value.tools} onRemove={removeTool} />
            </>
          )}
          <ManualToolEntry tools={value.tools} onChange={setTools} />
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

interface ToolSelectionProps {
  tools: string[];
  onChange: (tools: string[]) => void;
}

/** Loads the tools a saved server offers and lets them be picked from a list. */
function McpToolCatalog({ serverId, tools, onChange }: ToolSelectionProps & { serverId: string }) {
  const [catalog, setCatalog] = useState<McpToolMetadata[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  async function loadTools() {
    setLoading(true);
    setLoadError(null);
    try {
      setCatalog(await discoverMcpTools(serverId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load tools");
    } finally {
      setLoading(false);
    }
  }

  const selected = new Set(tools);
  const removeTool = (name: string) => onChange(tools.filter((tool) => tool !== name));
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTools = (catalog ?? []).filter(
    (tool) =>
      !normalizedQuery ||
      tool.name.toLowerCase().includes(normalizedQuery) ||
      tool.description?.toLowerCase().includes(normalizedQuery)
  );
  const catalogNames = new Set((catalog ?? []).map((tool) => tool.name));

  return (
    <>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={loadTools} disabled={loading}>
          <span className="inline-flex items-center gap-1">
            <RefreshIcon className="w-3.5 h-3.5" />
            {loading ? "Loading tools..." : catalog ? "Reload tools" : "Load tools"}
          </span>
        </Button>
        {catalog && (
          <span className="text-xs text-muted-foreground">
            {tools.filter((tool) => catalogNames.has(tool)).length} of {catalog.length} selected
          </span>
        )}
      </div>
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
              onClick={() => onChange([...new Set([...tools, ...visibleTools.map((t) => t.name)])])}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                const visible = new Set(visibleTools.map((tool) => tool.name));
                onChange(tools.filter((tool) => !visible.has(tool)));
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
                      isChecked ? removeTool(tool.name) : onChange([...tools, tool.name])
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

      {/* Once loaded, only selected names the server does not offer are listed,
          so they can be removed. */}
      <SelectedTools
        heading={catalog ? "Selected but not offered by the server:" : undefined}
        names={catalog ? tools.filter((tool) => !catalogNames.has(tool)) : tools}
        onRemove={removeTool}
      />
    </>
  );
}

interface SelectedToolsProps {
  names: string[];
  heading?: string;
  onRemove: (name: string) => void;
}

function SelectedTools({ names, heading, onRemove }: SelectedToolsProps) {
  if (names.length === 0) return null;
  return (
    <div>
      {heading && <p className="text-xs text-muted-foreground mb-1">{heading}</p>}
      <ul className="flex flex-wrap gap-1.5" aria-label="Selected tools">
        {names.map((tool) => (
          <li
            key={tool}
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground"
          >
            {tool}
            <button
              type="button"
              aria-label={`Remove ${tool}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onRemove(tool)}
            >
              <XIcon className="w-3 h-3" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ManualToolEntry({ tools, onChange }: ToolSelectionProps) {
  const [name, setName] = useState("");

  function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!tools.includes(trimmed)) onChange([...tools, trimmed]);
    setName("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  }

  return (
    <>
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Add a tool by name"
          aria-label="Tool name"
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Use the tool names the server advertises, such as <code>search_issues</code>.
      </p>
    </>
  );
}
