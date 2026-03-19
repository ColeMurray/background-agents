"use client";

import { useState, useCallback } from "react";
import { DEFAULT_MODEL, isValidCron } from "@open-inspect/shared";
import { useRepos } from "@/hooks/use-repos";
import { useBranches } from "@/hooks/use-branches";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { formatModelNameLower } from "@/lib/format";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RepoIcon, BranchIcon, ModelIcon, ChevronDownIcon } from "@/components/ui/icons";
import { CronPicker } from "./cron-picker";

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];

export interface AutomationFormValues {
  name: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  model: string;
  scheduleCron: string;
  scheduleTz: string;
  instructions: string;
}

interface AutomationFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<AutomationFormValues>;
  onSubmit: (values: AutomationFormValues) => void;
  submitting: boolean;
}

export function AutomationForm({ mode, initialValues, onSubmit, submitting }: AutomationFormProps) {
  const { repos, loading: loadingRepos } = useRepos();
  const { enabledModelOptions } = useEnabledModels();

  const [name, setName] = useState(initialValues?.name ?? "");
  const [selectedRepo, setSelectedRepo] = useState(
    initialValues?.repoOwner && initialValues?.repoName
      ? `${initialValues.repoOwner}/${initialValues.repoName}`
      : ""
  );
  const repoOwner = selectedRepo.split("/")[0] ?? "";
  const repoName = selectedRepo.split("/")[1] ?? "";
  const { branches, loading: loadingBranches } = useBranches(repoOwner, repoName);
  const [baseBranch, setBaseBranch] = useState(initialValues?.baseBranch ?? "");
  const [model, setModel] = useState(initialValues?.model ?? DEFAULT_MODEL);
  const [scheduleCron, setScheduleCron] = useState(initialValues?.scheduleCron ?? "0 9 * * *");
  const [scheduleTz, setScheduleTz] = useState(
    initialValues?.scheduleTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [instructions, setInstructions] = useState(initialValues?.instructions ?? "");
  const isScheduleValid = isValidCron(scheduleCron);

  const handleRepoChange = useCallback(
    (repoFullName: string) => {
      setSelectedRepo(repoFullName);
      const repo = repos.find((r) => r.fullName === repoFullName);
      if (repo) setBaseBranch(repo.defaultBranch);
    },
    [repos]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !selectedRepo || !instructions.trim() || !isScheduleValid) return;
    const values: AutomationFormValues = {
      name: name.trim(),
      repoOwner,
      repoName,
      baseBranch,
      model,
      scheduleCron,
      scheduleTz,
      instructions: instructions.trim(),
    };
    if (mode === "edit") {
      // UpdateAutomationRequest does not accept repoOwner/repoName
      delete (values as Partial<AutomationFormValues>).repoOwner;
      delete (values as Partial<AutomationFormValues>).repoName;
    }
    onSubmit(values);
  };

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const displayRepoName = selectedRepoObj ? selectedRepoObj.name : "Select repository";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Name */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Name</label>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily code review"
          maxLength={200}
          required
        />
      </div>

      {/* Repository */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={handleRepoChange}
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
          dropdownWidth="w-72"
          disabled={loadingRepos}
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <RepoIcon className="w-4 h-4 text-muted-foreground" />
          <span className="truncate flex-1 text-left">
            {loadingRepos ? "Loading..." : displayRepoName}
          </span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
      </div>

      {/* Branch */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Branch</label>
        <Combobox
          value={baseBranch}
          onChange={setBaseBranch}
          items={branches.map((b) => ({
            value: b.name,
            label: b.name,
          }))}
          searchable
          searchPlaceholder="Search branches..."
          filterFn={(option, query) => option.label.toLowerCase().includes(query)}
          dropdownWidth="w-56"
          disabled={!selectedRepo || loadingBranches}
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <BranchIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="truncate flex-1 text-left">
            {loadingBranches ? "Loading..." : baseBranch || "Select branch"}
          </span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
      </div>

      {/* Model */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Model</label>
        <Combobox
          value={model}
          onChange={setModel}
          items={
            enabledModelOptions.map((group) => ({
              category: group.category,
              options: group.models.map((m) => ({
                value: m.id,
                label: m.name,
                description: m.description,
              })),
            })) as ComboboxGroup[]
          }
          dropdownWidth="w-56"
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <ModelIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="truncate flex-1 text-left">{formatModelNameLower(model)}</span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
      </div>

      {/* Schedule */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Schedule</label>
        <CronPicker value={scheduleCron} onChange={setScheduleCron} timezone={scheduleTz} />
      </div>

      {/* Timezone */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Timezone</label>
        <Combobox
          value={scheduleTz}
          onChange={setScheduleTz}
          items={COMMON_TIMEZONES.map((tz) => ({
            value: tz,
            label: tz.replace(/_/g, " "),
          }))}
          searchable
          searchPlaceholder="Search timezones..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            String(option.value).toLowerCase().includes(query)
          }
          dropdownWidth="w-64"
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <span className="truncate flex-1 text-left">{scheduleTz.replace(/_/g, " ")}</span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
      </div>

      {/* Instructions */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Instructions</label>
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Run the test suite and fix any failing tests. If all tests pass, look for TODO comments and address the most impactful one."
          maxLength={10000}
          required
          rows={6}
          className="resize-y"
        />
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-3">
        <Button
          type="submit"
          disabled={
            submitting || !name.trim() || !selectedRepo || !instructions.trim() || !isScheduleValid
          }
        >
          {submitting
            ? mode === "create"
              ? "Creating..."
              : "Saving..."
            : mode === "create"
              ? "Create Automation"
              : "Save Changes"}
        </Button>
      </div>
    </form>
  );
}
