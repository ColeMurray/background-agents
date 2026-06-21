"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  DEFAULT_MENTIONS_POLICY,
  MAX_SLACK_ROUTING_RULES,
  type EnrichedRepository,
  type SlackGlobalConfig,
  type SlackGlobalSettings,
  type SlackMentionsPolicy,
  type SlackRepoSettings,
  type SlackRoutingRule,
} from "@open-inspect/shared";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/site-config";
import { RadioCard } from "@/components/ui/form-controls";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/slack";
const REPO_SETTINGS_KEY = "/api/integration-settings/slack/repos";

const MENTIONS_POLICY_OPTIONS: {
  value: SlackMentionsPolicy;
  label: string;
  description: string;
}[] = [
  {
    value: "allow",
    label: "Allow",
    description: "Direct user mentions like <@U123> are passed through to Slack.",
  },
  {
    value: "escape",
    label: "Escape",
    description: "Mentions are rendered as plain text — Slack will not notify the user.",
  },
  {
    value: "strip",
    label: "Strip",
    description: "Mentions are removed entirely from the message body.",
  },
];

interface GlobalResponse {
  settings: SlackGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: SlackRepoSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

/**
 * Merge a patch onto the current global defaults, dropping keys cleared to
 * `undefined`. The control plane replaces the whole settings blob on save, so
 * every section that writes it must preserve the others' fields; centralizing
 * the merge makes that a property of the data flow rather than per-section
 * discipline.
 */
function mergedGlobalDefaults(
  current: SlackGlobalConfig | null | undefined,
  patch: Partial<SlackGlobalSettings>
): SlackGlobalSettings {
  const defaults: SlackGlobalSettings = { ...current?.defaults, ...patch };
  for (const key of Object.keys(defaults) as (keyof SlackGlobalSettings)[]) {
    if (defaults[key] === undefined) delete defaults[key];
  }
  return defaults;
}

export function SlackIntegrationSettings() {
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">Slack</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Let agents post Slack notifications when the user explicitly asks for them. Posts go through
        the control plane — the Slack token never enters the sandbox.
      </p>

      <Section
        title="Channel access"
        description={`${APP_NAME} does not maintain its own channel allowlist.`}
      >
        <p className="text-sm text-muted-foreground">
          To make a channel available to agents, invite the {APP_NAME} Slack bot to a channel in
          Slack. The bot can post only to channels it&apos;s a member of; remove access by kicking
          the bot from the channel.
        </p>
      </Section>

      <GlobalSettingsSection settings={settings} />

      <RoutingRulesSection settings={settings} availableRepos={availableRepos} />

      <Section
        title="Repository overrides"
        description="Override the master switch for specific repositories. Mentions policy is workspace-wide and is not overridable per repo."
      >
        <RepoOverridesSection overrides={repoOverrides} availableRepos={availableRepos} />
      </Section>
    </div>
  );
}

function GlobalSettingsSection({ settings }: { settings: SlackGlobalConfig | null | undefined }) {
  const [agentNotificationsEnabled, setAgentNotificationsEnabled] = useState(
    settings?.defaults?.agentNotificationsEnabled ?? false
  );
  const [mentionsPolicy, setMentionsPolicy] = useState<SlackMentionsPolicy>(
    settings?.defaults?.mentionsPolicy ?? DEFAULT_MENTIONS_POLICY
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings === undefined || dirty || saving) return;
    setAgentNotificationsEnabled(settings?.defaults?.agentNotificationsEnabled ?? false);
    setMentionsPolicy(settings?.defaults?.mentionsPolicy ?? DEFAULT_MENTIONS_POLICY);
  }, [settings, dirty, saving]);

  const isConfigured = settings !== null && settings !== undefined;

  const handleConfirmReset = async () => {
    setSaving(true);
    try {
      // Reset only the notification/mention defaults. If routing rules exist,
      // preserve them by writing a blob that keeps just the rules (rather than
      // deleting the whole row); otherwise clear the row entirely.
      const existingRules = settings?.defaults?.routingRules;
      const res = existingRules?.length
        ? await fetch(GLOBAL_SETTINGS_KEY, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings: { defaults: { routingRules: existingRules } } }),
          })
        : await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });
      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setAgentNotificationsEnabled(false);
        setMentionsPolicy(DEFAULT_MENTIONS_POLICY);
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const body: SlackGlobalConfig = {
      defaults: mergedGlobalDefaults(settings, { agentNotificationsEnabled, mentionsPolicy }),
    };

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });
      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        toast.success("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Defaults"
      description="Workspace-wide settings for agent-initiated Slack posts."
    >
      <label
        htmlFor="slack-master-switch"
        className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer mb-4 rounded-sm"
      >
        <div>
          <span className="text-sm font-medium text-foreground">Enable agent notifications</span>
          <span className="text-sm text-muted-foreground ml-2">
            Master switch for the slack-notify tool. Off by default.
          </span>
        </div>
        <Switch
          id="slack-master-switch"
          checked={agentNotificationsEnabled}
          onCheckedChange={(checked) => {
            setAgentNotificationsEnabled(checked);
            setDirty(true);
          }}
        />
      </label>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Mentions policy</p>
        <p className="text-xs text-muted-foreground mb-2">
          How direct user mentions (<code>{"<@U…>"}</code>) are handled in agent messages. Broadcast
          mentions (<code>@channel</code>, <code>@here</code>, <code>@subteam</code>) are always
          stripped regardless of this setting.
        </p>
        <div className="grid sm:grid-cols-3 gap-2">
          {MENTIONS_POLICY_OPTIONS.map((opt) => (
            <RadioCard
              key={opt.value}
              name="slack-mentions-policy"
              checked={mentionsPolicy === opt.value}
              onChange={() => {
                setMentionsPolicy(opt.value);
                setDirty(true);
              }}
              label={opt.label}
              description={opt.description}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={() => setShowResetDialog(true)} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>
              Reset Slack defaults? The master switch will turn off and mentions policy will return
              to <strong>allow</strong>. Per-repository overrides and routing rules are not
              affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo.toLowerCase()));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const [owner, name] = addingRepo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/slack/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });
      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setAddingRepo("");
        toast.success("Override added.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to add override");
      }
    } catch {
      toast.error("Failed to add override");
    }
  };

  return (
    <div>
      {overrides.length > 0 ? (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow key={entry.repo} entry={entry} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to override the master switch for a specific repo.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1" aria-label="Select a repository">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {availableForOverride.map((repo) => (
              <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
      </div>
    </div>
  );
}

type OverrideMode = "inherit" | "on" | "off";

function deriveOverrideMode(settings: SlackRepoSettings): OverrideMode {
  if (settings.agentNotificationsEnabled === undefined) return "inherit";
  return settings.agentNotificationsEnabled ? "on" : "off";
}

function RepoOverrideRow({ entry }: { entry: RepoSettingsEntry }) {
  const [mode, setMode] = useState<OverrideMode>(deriveOverrideMode(entry.settings));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty || saving) return;
    setMode(deriveOverrideMode(entry.settings));
  }, [entry.settings, dirty, saving]);

  const handleSave = async () => {
    setSaving(true);
    const [owner, name] = entry.repo.split("/");
    const settings: SlackRepoSettings = {};
    if (mode === "on") settings.agentNotificationsEnabled = true;
    if (mode === "off") settings.agentNotificationsEnabled = false;

    try {
      const res = await fetch(`/api/integration-settings/slack/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setDirty(false);
        toast.success(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save override");
      }
    } catch {
      toast.error("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const [owner, name] = entry.repo.split("/");
    try {
      const res = await fetch(`/api/integration-settings/slack/repos/${owner}/${name}`, {
        method: "DELETE",
      });
      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        toast.success(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete override");
      }
    } catch {
      toast.error("Failed to delete override");
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border border-border rounded-sm">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-sm font-medium text-foreground truncate">{entry.repo}</span>
        <Select
          value={mode}
          onValueChange={(v: OverrideMode) => {
            setMode(v);
            setDirty(true);
          }}
        >
          <SelectTrigger density="compact" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">Inherit global setting</SelectItem>
            <SelectItem value="on">Override: notifications on</SelectItem>
            <SelectItem value="off">Override: notifications off</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>
    </div>
  );
}

interface DraftRoutingRule {
  /** Stable key for list rendering; not persisted. */
  id: number;
  keyword: string;
  target: string;
}

// Monotonic source of stable React keys for draft rows.
let draftRoutingRuleIdCounter = 0;

function toDraftRoutingRules(rules: SlackRoutingRule[] | undefined): DraftRoutingRule[] {
  return (rules ?? []).map((rule) => ({
    id: draftRoutingRuleIdCounter++,
    keyword: rule.keyword,
    target: rule.target,
  }));
}

function RoutingRulesSection({
  settings,
  availableRepos,
}: {
  settings: SlackGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
}) {
  const [rules, setRules] = useState<DraftRoutingRule[]>(() =>
    toDraftRoutingRules(settings?.defaults?.routingRules)
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings === undefined || dirty || saving) return;
    setRules(toDraftRoutingRules(settings?.defaults?.routingRules));
  }, [settings, dirty, saving]);

  const accessibleRepos = new Set(availableRepos.map((r) => r.fullName.toLowerCase()));
  const keywordCounts = new Map<string, number>();
  for (const rule of rules) {
    const key = rule.keyword.trim().toLowerCase();
    if (key) keywordCounts.set(key, (keywordCounts.get(key) ?? 0) + 1);
  }

  const updateRule = (id: number, patch: Partial<DraftRoutingRule>) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const addRule = () => {
    setRules((prev) => [...prev, { id: draftRoutingRuleIdCounter++, keyword: "", target: "" }]);
    setDirty(true);
  };

  const removeRule = (id: number) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  };

  const handleSave = async () => {
    const trimmed = rules.map((r) => ({ keyword: r.keyword.trim(), target: r.target.trim() }));
    if (trimmed.some((r) => !r.keyword || !r.target)) {
      toast.error("Every routing rule needs a keyword and a target repository.");
      return;
    }
    if (trimmed.length > MAX_SLACK_ROUTING_RULES) {
      toast.error(
        `You can define at most ${MAX_SLACK_ROUTING_RULES} routing rules (you have ${trimmed.length}). Remove ${trimmed.length - MAX_SLACK_ROUTING_RULES} to save.`
      );
      return;
    }

    setSaving(true);
    // Send the validated draft as-is and let the control-plane validator be the
    // single canonical normalizer (lowercase/de-dupe) on write. The UI's job is
    // to validate and present, not to own the stored shape.
    const body: SlackGlobalConfig = {
      defaults: mergedGlobalDefaults(settings, {
        routingRules: trimmed.length > 0 ? trimmed : undefined,
      }),
    };

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });
      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        toast.success("Routing rules saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save routing rules");
      }
    } catch {
      toast.error("Failed to save routing rules");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Routing rules"
      description="Map keywords to repositories. When a Slack message contains a keyword, the agent is routed to that repository before falling back to channel association or automatic detection."
    >
      {rules.length > 0 ? (
        <div className="space-y-3 mb-4">
          {rules.map((rule) => {
            const target = rule.target.trim().toLowerCase();
            const staleTarget = target !== "" && !accessibleRepos.has(target);
            const duplicateKeyword =
              rule.keyword.trim() !== "" &&
              (keywordCounts.get(rule.keyword.trim().toLowerCase()) ?? 0) > 1;

            // A target that is no longer accessible must still render so the user
            // can see and re-point it (Radix Select needs a matching item).
            const targetOptions = staleTarget
              ? [...availableRepos.map((r) => r.fullName), rule.target]
              : availableRepos.map((r) => r.fullName);

            return (
              <div key={rule.id}>
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Routing keyword"
                    value={rule.keyword}
                    onChange={(e) => updateRule(rule.id, { keyword: e.target.value })}
                    placeholder="keyword"
                    className="w-48 px-3 py-2 text-sm bg-input border border-border rounded-sm focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-secondary-foreground"
                  />
                  <span className="text-muted-foreground" aria-hidden="true">
                    &rarr;
                  </span>
                  <Select value={target} onValueChange={(v) => updateRule(rule.id, { target: v })}>
                    <SelectTrigger className="flex-1" aria-label="Routing target repository">
                      <SelectValue placeholder="Select a repository..." />
                    </SelectTrigger>
                    <SelectContent>
                      {targetOptions.map((fullName) => (
                        <SelectItem key={fullName} value={fullName.toLowerCase()}>
                          {fullName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="destructive" size="sm" onClick={() => removeRule(rule.id)}>
                    Remove
                  </Button>
                </div>
                {(staleTarget || duplicateKeyword) && (
                  <div className="mt-1 ml-1 space-y-0.5">
                    {staleTarget && (
                      <p className="text-xs text-warning">
                        <code>{rule.target}</code> is not in your accessible repositories — this
                        rule is ignored until access is restored.
                      </p>
                    )}
                    {duplicateKeyword && (
                      <p className="text-xs text-warning">
                        This keyword is used by more than one rule — matching messages will ask
                        which repository to use.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No routing rules yet. Add one to route messages containing a keyword to a specific
          repository.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={addRule}>
          Add rule
        </Button>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save routing rules"}
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Keywords match whole words, case-insensitively. Point each keyword at one repository; the
        same keyword on two repositories will prompt for a choice instead of guessing.
      </p>
    </Section>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}
