"use client";

import { useState, useMemo } from "react";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { resolveEnabledModel } from "@/lib/model-selection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAutomationTargets } from "./use-automation-targets";
import { AutomationAgentFields } from "./automation-agent-fields";
import { AutomationTargetPicker } from "./automation-target-picker";
import { AutomationInstructionsField } from "./automation-instructions-field";
import {
  AutomationTriggerConfigurationFields,
  AutomationTriggerTypeField,
} from "./automation-trigger-fields";
import {
  createAutomationFormDraft,
  evaluateAutomationForm,
  requiresRepositoryContext,
  type AutomationFormValues,
} from "./automation-form-policy";

export type { AutomationFormValues } from "./automation-form-policy";

interface AutomationFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<AutomationFormValues>;
  onSubmit: (values: AutomationFormValues) => void;
  submitting: boolean;
}

export function AutomationForm({ mode, initialValues, onSubmit, submitting }: AutomationFormProps) {
  const { repos, loading: loadingRepos } = useRepos();
  const { environments, loading: loadingEnvironments } = useEnvironments();
  const { enabledModels, enabledModelOptions, loading: loadingModels } = useEnabledModels();
  const initialDraft = useMemo(() => createAutomationFormDraft(initialValues), [initialValues]);
  const initialRepositories = useMemo(
    () => initialValues?.repositories ?? [],
    [initialValues?.repositories]
  );

  const [name, setName] = useState(initialDraft.name);
  const [agent, setAgent] = useState(initialDraft.agent);
  const [instructions, setInstructions] = useState(initialDraft.instructions);
  const [trigger, setTrigger] = useState(initialDraft.trigger);
  const repositoryRequired = requiresRepositoryContext(trigger.type);

  const isSchedule = trigger.type === "schedule";
  // Multi-repository selections are schedule-only (the server rejects them for
  // event triggers), so the mode toggle only exists there.
  const multiRepoAllowed = isSchedule;

  const targets = useAutomationTargets({
    initialRepositories,
    initialEnvironmentIds: initialValues?.environmentIds ?? [],
    multiRepoAllowed,
    repositoryRequired,
    repos,
  });
  const { selectedEnvironmentIds, buildRepositoriesPayload } = targets;

  // The model we display and submit. The selector only lists enabled models, so
  // a disabled default (blank create), a disabled saved model (edit), or a
  // disabled template suggestion is coerced to an enabled one. Until preferences
  // load we can't know the enabled set, so the raw selection stands and submit
  // is blocked — keeping display, reasoning, and the payload in agreement
  // without relying on a post-load effect.
  const resolvedModel = useMemo(
    () => (loadingModels ? agent.model : resolveEnabledModel(agent.model, enabledModels)),
    [agent.model, enabledModels, loadingModels]
  );

  const formEvaluation = evaluateAutomationForm({
    mode,
    loadingModels,
    resolvedModel,
    draft: {
      name,
      instructions,
      agent,
      trigger,
    },
    targets: {
      repositories: buildRepositoriesPayload(),
      environmentIds: selectedEnvironmentIds,
    },
  });
  const conditionErrors =
    !formEvaluation.valid && formEvaluation.reason === "invalid-conditions"
      ? formEvaluation.conditionErrors
      : [];
  const eventTypeError =
    !formEvaluation.valid && formEvaluation.reason === "event-type-required"
      ? "Event type is required."
      : "";
  const slackChannelError =
    !formEvaluation.valid && formEvaluation.reason === "slack-channel-required"
      ? "Slack triggers require at least one Slack Channel condition."
      : "";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formEvaluation.valid) return;
    onSubmit(formEvaluation.values);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <AutomationTriggerTypeField mode={mode} value={trigger} onChange={setTrigger} />

      {/* Name */}
      <div>
        <label
          htmlFor="automation-name"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Name
        </label>
        <Input
          id="automation-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isSchedule ? "Daily code review" : "Review new PRs"}
          maxLength={200}
          required
        />
      </div>

      <AutomationTargetPicker
        targets={targets}
        repos={repos}
        environments={environments}
        loadingRepos={loadingRepos}
        loadingEnvironments={loadingEnvironments}
        multiTargetAllowed={multiRepoAllowed}
        repositoryRequired={repositoryRequired}
      />

      <AutomationAgentFields
        value={agent}
        resolvedModel={resolvedModel}
        enabledModelOptions={enabledModelOptions}
        onChange={setAgent}
      />

      <AutomationTriggerConfigurationFields
        mode={mode}
        value={trigger}
        onChange={setTrigger}
        eventTypeError={eventTypeError}
        slackChannelError={slackChannelError}
        conditionErrors={conditionErrors}
      />

      <AutomationInstructionsField
        value={instructions}
        triggerType={trigger.type}
        onChange={setInstructions}
      />

      {/* Submit */}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={submitting || !formEvaluation.valid}>
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
